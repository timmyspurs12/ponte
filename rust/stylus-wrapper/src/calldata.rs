//! Bounded preflight for the single dynamic public method. No decoded values or
//! variable-sized buffers are allocated here; Alloy remains the typed decoder.

use alloc::vec::Vec;
use stylus_sdk::ArbResult;

pub(crate) const MAX_CALLDATA: usize = 25_572;
const MAX_CANDIDATES: usize = 64;
const MAX_STRING_BYTES: usize = 64;
const WORD: usize = 32;
const REQUEST_HEAD: usize = 11 * WORD;
const ASSET_HEAD: usize = 3 * WORD;
const CANDIDATE_SIZE: usize = 12 * WORD;
const SELECTOR: [u8; 4] = [0x31, 0x63, 0x19, 0x81];

fn span(data: &[u8], start: usize, size: usize) -> Option<&[u8]> {
    data.get(start..start.checked_add(size)?)
}

fn word(data: &[u8], at: usize) -> Option<usize> {
    let bytes = span(data, at, WORD)?;
    let width = core::mem::size_of::<usize>();
    if bytes[..WORD - width].iter().any(|&b| b != 0) {
        return None;
    }
    let mut value = 0usize;
    for &byte in &bytes[WORD - width..] {
        value = value.checked_mul(256)?.checked_add(usize::from(byte))?;
    }
    Some(value)
}

fn dynamic(data: &[u8], base: usize, at: usize, min_offset: usize) -> Option<usize> {
    let offset = word(data, at)?;
    if offset < min_offset || offset % WORD != 0 {
        return None;
    }
    let target = base.checked_add(offset)?;
    span(data, target, WORD)?;
    Some(target)
}

fn asset(data: &[u8], request: usize, field: usize) -> Option<()> {
    let asset = dynamic(data, request, request.checked_add(field * WORD)?, REQUEST_HEAD)?;
    span(data, asset, ASSET_HEAD)?;
    for field in 0..2 {
        let string = dynamic(data, asset, asset.checked_add(field * WORD)?, ASSET_HEAD)?;
        let len = word(data, string)?;
        if len > MAX_STRING_BYTES {
            return None;
        }
        let padded = len.checked_add(WORD - 1)? / WORD * WORD;
        span(data, string.checked_add(WORD)?, padded)?;
    }
    Some(())
}

/// Checks the dynamic ABI portions of evaluateSynthetic. This validates bounds
/// and alignment, not scalar types, UTF-8, padding contents, or full canonicality.
fn request(data: &[u8]) -> Option<()> {
    let request = dynamic(data, 0, 0, WORD)?;
    span(data, request, REQUEST_HEAD)?;
    asset(data, request, 2)?;
    asset(data, request, 3)?;
    let array = dynamic(data, request, request.checked_add(10 * WORD)?, REQUEST_HEAD)?;
    let count = word(data, array)?;
    if count > MAX_CANDIDATES {
        return None;
    }
    span(data, array.checked_add(WORD)?, count.checked_mul(CANDIDATE_SIZE)?)?;
    Some(())
}

/// The read and route callbacks make both security boundaries observable in
/// native tests. Production supplies the SDK host reader and SDK router.
pub(crate) fn dispatch_bounded(
    len: usize,
    read: impl FnOnce(usize) -> Vec<u8>,
    route: impl FnOnce(Vec<u8>) -> ArbResult,
) -> ArbResult {
    if len > MAX_CALLDATA {
        return Err(Vec::new());
    }
    let data = read(len);
    if data.len() != len {
        return Err(Vec::new());
    }
    // Unknown and short selectors continue to the SDK's existing router.
    if data.starts_with(&SELECTOR) && request(&data[4..]).is_none() {
        return Err(Vec::new());
    }
    route(data)
}
