# gitto

ローカルのGitリポジトリをブラウザーで閲覧する、読み取り専用のCLIです。
コミット履歴、ブランチ・タグ、ファイル、staged／unstaged／untrackedの差分を表示します。

## 起動

```sh
nix run . -- .
```

開発シェルでは、ビルド済みのコマンドをそのまま使えます。

```sh
nix develop
gitto .
```

指定したパスからGitリポジトリを探すため、サブディレクトリからも起動できます。
1リポジトリにつき1プロセスで、`127.0.0.1`の空きポートを使います。
ブラウザーが開き、`Ctrl+C`で終了します。複数のリポジトリを同時に開けます。

```sh
gitto /path/to/repository
gitto . --no-open
gitto . --port 3000
gitto --help
```

ブラウザーを開けなかった場合は、ターミナルに表示されたURLを手動で開いてください。
GitコマンドやNode.jsは、ビルド済みバイナリの実行には必要ありません。
Nixで生成したバイナリはNix storeに依存するため、別のマシンへ単体コピーする配布には使いません。

## 閲覧

- ブランチ・タグを選んで、履歴とファイルツリーを切り替えます。
- コミットを選ぶと、その時点のツリーと最初の親コミットとの差分を表示します。
  最初のコミットは空のツリーと比較します。
- フォルダーとファイルを選ぶと、内容を表示します。シンボリックリンクはリンク先の文字列を表示します。
- ファイルと差分に構文ハイライトと行番号を表示します。通常のファイルでは追加・変更・削除位置を行番号の横に示します。
  作業中はHEADと作業ツリー、履歴では第1親と選択コミットを比較します。
- 差分は本文1列で表示し、追加・削除の色と記号を行番号の右側に示します。
  Gitのメタデータ行は省き、コードは通常の構文ハイライトで表示します。
- 変更一覧では、HEADとindexの差分をStaged、indexと作業ツリーの差分をUnstagedとして表示します。
  同じファイルに両方の変更がある場合は、それぞれの一覧に表示します。
- 履歴・ブランチ・変更一覧・ファイルツリー・開いている内容は、約2秒間隔で自動更新します。
  選択やフォルダーの展開を保ち、非表示のタブでは取得を止め、戻ったときにすぐ更新します。
  過去のコミットを選んでいる場合は、そのコミットの表示を保ちます。ブランチを閲覧してもcheckoutはしません。

コミットがまだないリポジトリでも、作業中の変更を表示できます。
bareリポジトリでは履歴とコミット済みファイルを閲覧できますが、作業ツリーの操作はありません。
Gitのcommit・stage・checkout・fetchやファイルの編集は行いません。

## 表示範囲

テキストはUTF-8で表示します。バイナリ、2 MiBを超えるファイル、サブモジュールの内部は表示しません。
差分の本文も2 MiBまでで、省略した場合は画面に示します。
Gitのパス・メタデータがUTF-8でない場合は、エラーを表示します。
Markdownとコードはテキストとして表示し、HTMLを実行しません。

サーバーはloopbackに限定し、起動時に表示したHost以外のリクエストを拒否します。
Unstagedの競合差分はindexのstage 2（ours）と現在の作業ファイルを比較し、競合マーカーも表示します。
通常ファイルの変更マークは、競合中もHEADとの比較を使います。
frontendはMVPのため、base・ours・theirsを並べる3-way表示はありません。

CORSは許可しません。作業ツリーから`.git`やリポジトリ外のファイルを読み出しません。

## 開発

RustのCLIとHTTPサーバーをルートに、Vite+・React・TypeScriptを`frontend/`に置きます。
frontendはpnpmで依存を固定し、`vp`で開発・ビルド・テスト・lint・formatを実行します。
Gitへのアクセスにはgit2-rsと同梱したlibgit2を使います。
frontendの生成物はrust-embedで実行ファイルへ埋め込みます。

```sh
nix develop
(cd frontend && pnpm install --frozen-lockfile && pnpm exec vp build)
cargo build
```

HMRを使う場合は、別々のターミナルで起動します。

```sh
cargo run -- . --port 3000 --no-open
```

```sh
cd frontend
pnpm exec vp dev
```

`http://127.0.0.1:5173`を開きます。Viteが`/api`をRustへプロキシします。

## 検証とビルド

```sh
nix flake check
nix build
```

`nix build`はfrontendのビルドから実行するため、ローカルに生成済みの`dist`は不要です。
生成したCLIは`./result/bin/gitto`にあります。

個別に確認する場合は、次のコマンドを使います。

```sh
cargo test
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
(cd frontend && pnpm exec vp test && pnpm exec vp check)
```

テストはすべてunit testです。Rustは各ソース内、TypeScriptは対象ファイルの隣に置きます。
Git fixtureや外部リポジトリに依存するテスト、E2Eテストは作りません。
ライブラリのGit処理を再検証せず、独自の入力検証・状態変換・UIを検証します。
CLI・HTTP・ブラウザーの連携は、起動後に手動で確認します。

## HTTP API

すべて読み取り専用のGETです。エラーはHTTPステータスと`{"error":"説明"}`で返します。
`revision`の既定値は`HEAD`です。

| パス | 内容 |
| --- | --- |
| `/api/repo` | 名前、パス、HEAD、bare状態、ローカル・remoteブランチとタグ |
| `/api/commits?revision=HEAD&offset=0&limit=50` | 履歴。`limit`は1〜100 |
| `/api/tree?revision=HEAD&path=src` | 指定ディレクトリのエントリー |
| `/api/file?source=commit&revision=HEAD&path=README.md` | ファイル。`source`は`commit`、`index`、`worktree` |
| `/api/status` | staged、unstaged、untracked、conflictsの一覧 |
| `/api/diff?source=staged&path=src/main.rs` | 差分。`source`は`staged`、`unstaged`、`untracked`、`worktree`、`commit`。`path`は省略可能 |

`commit`差分では`revision`を指定できます。作業中の差分は常に現在のHEAD・index・作業ツリーを使います。
`worktree`はHEADから作業ツリーまでの変更をまとめ、未追跡ファイルも含めます。
