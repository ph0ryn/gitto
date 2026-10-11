{
  description = "A read-only local Git browser";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    {
      self,
      nixpkgs,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forEachSystem = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forEachSystem (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
          };
          frontend = import ./nix/frontend.nix {
            inherit pkgs;
          };
          gitto = import ./nix/package.nix {
            inherit pkgs frontend;
          };
        in
        {
          inherit frontend gitto;
          default = gitto;
        }
      );

      apps = forEachSystem (
        system:
        let
          gitto = self.packages.${system}.gitto;
        in
        {
          default = {
            meta = {
              description = "A read-only local Git browser";
              mainProgram = "gitto";
            };
            type = "app";
            program = "${gitto}/bin/gitto";
          };
        }
      );

      devShells = forEachSystem (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
          };
          gitto = self.packages.${system}.gitto;
        in
        {
          default = pkgs.mkShell {
            packages = [
              gitto
              pkgs.cargo
              pkgs.clippy
              pkgs.cmake
              pkgs.git
              pkgs.nixfmt
              pkgs.nodejs_24
              pkgs.pkg-config
              pkgs.pnpm
              pkgs.rumdl
              pkgs.rustc
              pkgs.rustfmt
            ];
          };
        }
      );

      checks = forEachSystem (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
          };
          frontend = self.packages.${system}.frontend;
          gitto = self.packages.${system}.gitto;
          checks = import ./nix/checks.nix {
            inherit pkgs frontend gitto;
          };
        in
        checks
      );
    };
}
