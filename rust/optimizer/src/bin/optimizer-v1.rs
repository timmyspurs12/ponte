//! Host-side JSON-lines test and benchmark adapter for `ponte-optimizer`.
//!
//! Test/benchmark adapter only — not an application API or production service.

#![forbid(unsafe_code)]
#![deny(clippy::float_arithmetic)]

use ponte_optimizer::{
    OptimizeOutcomeV1, OptimizeRequestV1, evaluate_json_line, optimize_v1,
    parse_request_v1_json,
};
use std::{
    env, fs,
    hint::black_box,
    io::{self, BufRead, BufWriter, Write},
    process::ExitCode,
    time::Instant,
};

fn run_jsonl_stream() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());

    for line_res in stdin.lock().lines() {
        let line = line_res?;
        let response = evaluate_json_line(&line);
        writer.write_all(response.as_bytes())?;
        writer.write_all(b"\n")?;
    }
    writer.flush()
}

fn format_u128_vec_json(values: &[u128]) -> String {
    let mut out = String::from("[");
    for (idx, val) in values.iter().enumerate() {
        if idx > 0 {
            out.push(',');
        }
        out.push_str(&val.to_string());
    }
    out.push(']');
    out
}

fn run_benchmark(
    jsonl_path: &str,
    warmup_passes: usize,
    measure_passes: usize,
) -> Result<(), String> {
    let content = fs::read_to_string(jsonl_path)
        .map_err(|e| format!("failed to read dataset {jsonl_path}: {e}"))?;
    let lines: Vec<&str> = content.lines().filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return Err("benchmark dataset is empty".to_string());
    }

    let mut parsed_requests: Vec<OptimizeRequestV1> = Vec::with_capacity(lines.len());
    for line in &lines {
        let req = parse_request_v1_json(line)
            .map_err(|e| format!("benchmark dataset parse error: {e}"))?;
        parsed_requests.push(req);
    }

    let mut sink: u64 = 0;

    // 1. Warmup pre-parsed core evaluation
    for _ in 0..warmup_passes {
        for req in &parsed_requests {
            let out = black_box(optimize_v1(black_box(req)));
            match out {
                Ok(OptimizeOutcomeV1::Selected(sel)) => {
                    let low = u64::try_from(sel.expected_out & 0xffff).unwrap_or(0);
                    sink = sink.wrapping_add(low);
                }
                _ => {
                    sink = sink.wrapping_add(1);
                }
            }
        }
    }

    // 2. Measure pre-parsed core evaluation
    let mut core_batch_ns: Vec<u128> = Vec::with_capacity(measure_passes);
    for _ in 0..measure_passes {
        let start = Instant::now();
        for req in &parsed_requests {
            let out = black_box(optimize_v1(black_box(req)));
            match out {
                Ok(OptimizeOutcomeV1::Selected(sel)) => {
                    let low = u64::try_from(sel.expected_out & 0xffff).unwrap_or(0);
                    sink = sink.wrapping_add(low);
                }
                _ => {
                    sink = sink.wrapping_add(1);
                }
            }
        }
        core_batch_ns.push(start.elapsed().as_nanos());
    }

    // 3. Warmup & measure JSON parse + core evaluate + canonical serialize separately
    let json_warmups = (warmup_passes / 4).max(3);
    let json_measures = (measure_passes / 5).max(10);
    for _ in 0..json_warmups {
        for &line in &lines {
            let out = black_box(evaluate_json_line(black_box(line)));
            sink = sink.wrapping_add(u64::try_from(out.len()).unwrap_or(0));
        }
    }

    let mut json_batch_ns: Vec<u128> = Vec::with_capacity(json_measures);
    for _ in 0..json_measures {
        let start = Instant::now();
        for &line in &lines {
            let out = black_box(evaluate_json_line(black_box(line)));
            sink = sink.wrapping_add(u64::try_from(out.len()).unwrap_or(0));
        }
        json_batch_ns.push(start.elapsed().as_nanos());
    }

    println!(
        "{{\"coreBatchNs\":{},\"jsonBatchNs\":{},\"requestCount\":{},\"checksum\":\"{:x}\"}}",
        format_u128_vec_json(&core_batch_ns),
        format_u128_vec_json(&json_batch_ns),
        parsed_requests.len(),
        black_box(sink),
    );
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        if let Err(err) = run_jsonl_stream() {
            eprintln!("optimizer-v1 I/O error: {err}");
            return ExitCode::FAILURE;
        }
        return ExitCode::SUCCESS;
    }

    if args.len() == 4 && args[0] == "--bench" {
        let warmup = match args[2].parse::<usize>() {
            Ok(v) => v,
            Err(_) => {
                eprintln!("invalid warmup_passes integer");
                return ExitCode::FAILURE;
            }
        };
        let measure = match args[3].parse::<usize>() {
            Ok(v) if v > 0 => v,
            _ => {
                eprintln!("invalid measure_passes integer");
                return ExitCode::FAILURE;
            }
        };
        if let Err(msg) = run_benchmark(&args[1], warmup, measure) {
            eprintln!("{msg}");
            return ExitCode::FAILURE;
        }
        return ExitCode::SUCCESS;
    }

    eprintln!("usage: optimizer-v1 | optimizer-v1 --bench <dataset.jsonl> <warmup> <measure>");
    ExitCode::FAILURE
}
