# AGENTS.md

## 基本仕様

- gittoは読み取り専用である。Gitや作業ツリーを書き換える機能は追加しない。
- CLI名と基本コマンドは`gitto .`である。

## 構成

- ルートは単一のRustパッケージで、CLIとHTTPサーバーをまとめる。
- `frontend/`はVite+・React・TypeScriptで構築する。
- `flake.nix`と`nix/`で開発環境・frontendビルド・Rustビルド・検証を管理する。
- `flake.lock`・`Cargo.lock`・`frontend/pnpm-lock.yaml`をコミットする。

## テストと検証

- テストはすべてunit testとし、自前のロジックとUIの振る舞いを対象にする。
- Rustは各ソース内の`#[cfg(test)]`、TypeScriptは隣接する`*.test.ts`・`*.test.tsx`に置く。
- Git fixture、`tests/`、E2Eテストは作らない。ライブラリの処理は信用し、再検証しない。
- `cargo test`・`cargo fmt --all -- --check`・`cargo clippy --all-targets -- -D warnings`を使う。
- frontendはpnpmとVite+の`vp`を使う。Prettierは使わない。
- frontendの検証は`vp test`・`vp check`と`package.json`のscriptsを使う。
- 全体の検証は`nix flake check`、完成CLIのビルドは`nix build`を使う。
- CLI・HTTP・ブラウザーの連携は手動で確認する。
