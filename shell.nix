{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = with pkgs; [
    (python3.withPackages (ps: with ps; [
      fastapi
      uvicorn
      python-multipart
      claude-agent-sdk
      pymupdf  # text extraction for Codex (it can't read PDFs directly)
    ]))
    nodejs
  ];

  shellHook = ''
    export PROJECT_ROOT="$(pwd)"
    export PDF_ANALYZER_DATA="''${PDF_ANALYZER_DATA:-$PROJECT_ROOT/data}"
    # Force Claude Code to use your subscription login, never per-token API billing.
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
  '';
}
