# AGENTS.md

## 応答と実装

- 日本語で丁寧に回答し、UTF-8を用いる。
- 既存の実装と規約を先に確認し、目的に必要な最小限の変更を行う。
- エラーや欠損を黙示的なフォールバックで隠さない。
- gittoは読み取り専用である。Gitや作業ツリーを書き換える機能は追加しない。
- CLI名と基本コマンドは`gitto .`である。

## 構成

- ルートは単一のRustパッケージで、CLIとHTTPサーバーをまとめる。
- `frontend/`はVite+・React・TypeScriptで構築する。
- `flake.nix`と`nix/`で開発環境・frontendビルド・Rustビルド・検証を管理する。
- `flake.lock`・`Cargo.lock`・`frontend/pnpm-lock.yaml`をコミットする。
- TypeScriptのファイル名はcamelCaseを使う。

## テストと検証

- テストはすべてunit testとし、自前のロジックとUIの振る舞いを対象にする。
- Rustは各ソース内の`#[cfg(test)]`、TypeScriptは隣接する`*.test.ts`・`*.test.tsx`に置く。
- Git fixture、`tests/`、E2Eテストは作らない。ライブラリの処理は信用し、再検証しない。
- 新しい独自ロジックは、意味のある最小シナリオを先に失敗させてから実装する。
- `cargo test`・`cargo fmt --all -- --check`・`cargo clippy --all-targets -- -D warnings`を使う。
- frontendはpnpmとVite+の`vp`を使う。Prettierは使わない。
- frontendの検証は`vp test`・`vp check`と`package.json`のscriptsを使う。
- 全体の検証は`nix flake check`、完成CLIのビルドは`nix build`を使う。
- Markdownは`nix run nixpkgs/nixpkgs-unstable#rumdl check --fix <path>`で確認する。
- CLI・HTTP・ブラウザーの連携は手動で確認する。
- 成果物は独立したreviewer_deepへレビューを依頼し、必須の指摘を解消する。

## Git

- 変更はレビュー可能な意味の単位でコミットし、英語のConventional Commitsを使う。
- merge・push・PR作成・外部公開は、実行前にユーザーへ確認する。
- 完了報告では、検証結果とmerge・push・PR作成の実施状況を示す。
