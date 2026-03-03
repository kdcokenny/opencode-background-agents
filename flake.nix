{
  description = "opencode-background-agents (node package)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };

      in
      {
        packages.default = pkgs.buildNpmPackage {
          pname = "kdco-background-agents";
          version = "0.1.0";
          src = self;

          npmDepsHash = "sha256-l/hjcGlqjh0TV3PLlJoZQPn+sox6vdu3ZvfZ2FQEAYI=";
          nativeBuildInputs = [ pkgs.bun ];
          npmBuildScript = "build";
        };
      }
    );
}
