//! Toolchain smoke test only. No PONTE financial or optimizer logic.

/// Exercise a pinned, downloaded dependency on native and WASM targets.
pub fn format_probe(value: u64) -> String {
    let mut buffer = itoa::Buffer::new();
    buffer.format(value).to_owned()
}

#[cfg(test)]
mod tests {
    use super::format_probe;

    #[test]
    fn formats_integer_boundaries() {
        assert_eq!(format_probe(0), "0");
        assert_eq!(format_probe(42), "42");
        assert_eq!(format_probe(u64::MAX), "18446744073709551615");
    }
}
