{
  pkgs,
  frontend,
  gitto,
}:

let
  source = pkgs.lib.fileset.toSource {
    root = ../.;
    fileset = pkgs.lib.fileset.unions (
      [
        ../Cargo.lock
        ../Cargo.toml
        ../LICENSE
        ../THIRD_PARTY_NOTICES.txt
        ../src
      ]
      ++ pkgs.lib.optional (builtins.pathExists ../README.md) ../README.md
    );
  };

  frontendSource = frontend.src;

  rustClippy = pkgs.rustPlatform.buildRustPackage {
    pname = "gitto-backend-clippy";
    version = "0.2.1";
    src = source;
    cargoLock.lockFile = ../Cargo.lock;

    nativeBuildInputs = [
      pkgs.clippy
      pkgs.cmake
      pkgs.pkg-config
    ];

    preBuild = ''
      mkdir -p frontend/dist
      cp -r ${frontend}/dist/. frontend/dist/
    '';

    doCheck = false;
    buildPhase = ''
      runHook preBuild
      cargo clippy --all-targets --all-features -- -D warnings
      runHook postBuild
    '';
    installPhase = ''
      mkdir -p "$out"
      touch "$out/checked"
    '';
  };

  rustFmt =
    pkgs.runCommand "gitto-backend-fmt"
      {
        nativeBuildInputs = [
          pkgs.cargo
          pkgs.rustfmt
        ];
      }
      ''
        cp -r ${source} source
        chmod -R u+w source
        cd source
        cargo fmt --all -- --check
        touch "$out"
      '';

  pnpmCheck =
    name: script:
    let
      recipe = pkgs.stdenvNoCC.mkDerivation {
        pname = "gitto-frontend-${name}";
        version = "0.2.1";
        src = frontendSource;
        inherit (frontend) nativeBuildInputs configurePhase impureEnvVars;
        env.CI = "true";
        dontFixup = true;
        # A predictable success marker must not be accepted from a substituter.
        allowSubstitutes = false;
        preferLocalBuild = true;
        buildPhase = ''
          runHook preBuild
          export VP_PACKAGE_MANAGER="pnpm@${pkgs.pnpm.version}"
          pnpm run ${script}
          ${pkgs.lib.optionalString (script == "build") ''
            diff -r ${frontend}/dist dist
          ''}
          runHook postBuild
        '';
        installPhase = ''
          printf %s "$checkKey" > "$out"
        '';
      };
      # Networked checks must invalidate on source, tool, or check recipe changes,
      # even when those changes leave the frontend's dist output unchanged.
      checkKey = builtins.hashString "sha256" (builtins.unsafeDiscardStringContext recipe.drvPath);
    in
    recipe.overrideAttrs {
      inherit checkKey;
      outputHashAlgo = "sha256";
      outputHashMode = "flat";
      outputHash = builtins.hashString "sha256" checkKey;
    };

in
{
  backend-tests = gitto;
  backend-clippy = rustClippy;
  backend-fmt = rustFmt;
  frontend-tests = pnpmCheck "tests" "test";
  frontend-format = pnpmCheck "format" "format:check";
  frontend-check = pnpmCheck "check" "check";
  frontend-build = pnpmCheck "build" "build";
  inherit gitto;
}
