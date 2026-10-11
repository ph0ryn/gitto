{ pkgs, frontend }:

pkgs.rustPlatform.buildRustPackage {
  pname = "gitto";
  version = "0.1.0";
  src = pkgs.lib.fileset.toSource {
    root = ../.;
    fileset = pkgs.lib.fileset.unions (
      [
        ../Cargo.lock
        ../Cargo.toml
        ../src
      ]
      ++ pkgs.lib.optional (builtins.pathExists ../README.md) ../README.md
    );
  };

  cargoLock.lockFile = ../Cargo.lock;

  nativeBuildInputs = [
    pkgs.cmake
    pkgs.pkg-config
  ];

  preBuild = ''
    mkdir -p frontend/dist
    cp -r ${frontend}/dist/. frontend/dist/
  '';

  doCheck = true;
}
