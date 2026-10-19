# gitto

<p align="center">
  <img src="docs/screenshot.png" alt="gitto screenshot" width="800">
</p>

ローカルのGitリポジトリをブラウザーで閲覧する、読み取り専用のCLIです。  
コミット履歴、ブランチ・タグ、ファイル、staged／unstaged／untrackedの差分を表示します。

## Demo

[Interactive preview](https://ph0ryn.github.io/gitto/)で、インストールせずにgittoのUIを試せます。
架空のリポジトリを使い、ファイル閲覧・差分・コミット履歴・ブランチ切り替え・全文検索を操作できます。

## Usage

```sh
nix run github:ph0ryn/gitto#gitto -- .
```

インストール後は、`gitto .`でリポジトリを開けます。CLIはURLの表示・ブラウザーの起動後に終了するため、ターミナルを占有しません。
共有サーバーは必要時にバックグラウンドで起動し、ターミナルを閉じても動き続けます。常設サービスへの登録は不要です。

```sh
gitto /path/to/repository
gitto . --no-open
gitto --list                 # --lsでも同じ
gitto . --port 47320          # 別の固定ポートを指定
gitto --list --port 47320     # そのポートの登録一覧
gitto --licenses
gitto --help
```

### Multiple repositories and stable URLs

既定の接続先は`127.0.0.1:47319`です。リポジトリを追加しても同じサーバー・ポートを使い、`http://127.0.0.1:47319/r/<ID>/`のようにIDで区別します。
同じ作業ツリーは同じID・URLを再利用し、別のworktreeは別の登録として扱います。`gitto ls`は一覧コマンドではなく、`ls`というディレクトリを開きます。

ポートがほかのアプリに使われていたら、`Use --port <port>`を含むエラーを表示します。空きポートへの自動切り替えはしません。
`--port`は1〜65535の固定ポートを指定するオプションで、0は使えません。ポートごとにサーバーと登録一覧を分離します。

### Sessions and server lifetime

- ブラウザーは約2秒ごとにheartbeatを送信します。同じリポジトリのどれかのタブから届いていれば、一覧の状態は`active`です。
- 30秒届かなければ閲覧セッションを暗黙終了し、`inactive`にします。ID・パスは保持します。登録から初回heartbeatまでの猶予も30秒で、`--no-open`でも同じです。
- ブランチ選択の右にある赤い「×」（`Close repository`）を押すと、確認なしでそのリポジトリの登録を削除します。同じリポジトリを開いたほかのタブも終了対象です。Gitや作業ツリーは変更しません。
- 利用中のリポジトリがなくなっても、暗黙終了したセッションの切断判定から1時間はHTTP受付を残します。この間はブラウザーだけで再接続できます。
- 利用中のセッションも待機猶予もなくなれば共有サーバーは終了します。明示終了で最後のセッションと待機猶予がなくなった場合は、1時間待たずに終了します。過去の登録だけでは起動し続けません。
- サーバー終了後もID・パスは残ります。次の`gitto [path]`で同じポートのサーバーが起動すれば、保持されている古いURLも再び使えます。停止したサーバーをブラウザーだけで起動することはできません。

同じブラウザープロファイルのタブには明示終了を通知し、後で再開したタブにも終了状態を引き継ぎます。
別プロファイルや通信断中のタブは、最後の登録の削除とサーバー終了をその場では区別できず、再接続待ちになる場合があります。登録はすでに削除されているため、サーバーの次回起動後もそのURLからは閲覧できません。

`--list`はID・状態・パスを表示します。サーバー停止中も起動せずに一覧を読み、すべて`inactive`として表示します。
保存先は`$XDG_CACHE_HOME/gitto/<port>/`、未設定なら`$HOME/.cache/gitto/<port>/`です。登録はディスクに保存し、実行中のセッションは復元しません。
リポジトリを移動・削除した場合や登録データが壊れた場合は、別の場所へ黙って切り替えずエラーを表示します。

サーバーはloopbackだけで待ち受け、Host・Originの検証を行います。CLI用の登録APIは、利用者だけが読めるローカルトークンで保護します。
起動失敗の詳細は、同じ保存先の`server.log`で確認できます。

## Installation

### Prebuilt binary

Nixなしで利用する場合は、[GitHub Releases](https://github.com/ph0ryn/gitto/releases)から環境に合う`gitto-<version>-<target>.tar.gz`をダウンロードします。

| OS / CPU | target |
| --- | --- |
| macOS / Apple Silicon | `aarch64-apple-darwin` |
| Linux / x86_64 | `x86_64-unknown-linux-musl` |
| Linux / ARM64 | `aarch64-unknown-linux-musl` |

ダウンロードしたファイルを展開し、`gitto`を任意の場所に配置します。

```sh
tar -xzf 'gitto-<version>-<target>.tar.gz'
```

### Nix

利用する`flake.nix`にgittoのinputを追加します。

```nix
inputs.gitto = {
  url = "github:ph0ryn/gitto";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

NixOS・nix-darwinの設定モジュールに、overlayとパッケージを追加します。

```nix
{ inputs, pkgs, ... }:
{
  nixpkgs.overlays = [ inputs.gitto.overlays.default ];
  environment.systemPackages = [ pkgs.gitto ];
}
```

対応するsystemは`x86_64-linux`・`aarch64-linux`・`aarch64-darwin`です。

## Features

- ブランチ・タグを選んで、コミット履歴やファイルを閲覧できます。
- コミットを選んで、過去のファイルやそのコミットの変更内容を確認できます。
- 作業中の変更を、Staged・Unstaged・Untrackedに分けて確認できます。
- ファイルと差分を、構文ハイライトと行番号付きで閲覧できます。通常のファイル表示でも変更箇所を確認できます。
- 作業ツリーまたは閲覧中のブランチ・コミットを全文検索できます。ファイルごとに一致箇所の前後を表示し、該当行を開けます。
- リポジトリの変更を約2秒ごとに自動で反映します。選択中のコミットやフォルダーの展開は維持されます。
- 最初のコミットを作る前でも、作業中の変更を確認できます。

## Limitations

- 閲覧専用です。ファイルの編集やcommit・stage・checkout・fetchはできません。
- 起動したマシン上のブラウザーで利用します。他のマシンからのアクセスには対応していません。
- ファイルの内容はUTF-8のテキストのみ表示します。バイナリ、2 MiBを超えるファイル、サブモジュールの内容はプレビューできません。2 MiBを超えるファイルの差分も本文を省略しますが、追加・削除行数は表示します。
- 構文ハイライトは16 KiBまでです。それを超える本文や差分は、ハイライトなしのテキストとして表示します。
- 全文検索は大文字・小文字を区別する文字列検索です。作業ツリーでは未追跡ファイルも含め、ignoredファイルは除外します。バイナリ、非UTF-8、2 MiB超、サブモジュールは検索対象外です。結果は最大200一致行・本文合計2 MiBで、省略を画面に表示します。検索語の強調は各抜粋16 KiB・1,000箇所までです。検索結果の更新は検索を再実行してください。
- 差分の本文は2 MiBまで取得し、表示は最大1,000行です。省略がある場合は画面に表示します。
- 差分の追加・削除行数はファイル全体から計算します。表示上限を超えるファイルも計算対象です。
- GitのパスやメタデータがUTF-8でない場合は、エラーを表示します。
- MarkdownやHTMLはテキストとして表示します。MarkdownのプレビューやHTMLの実行はできません。
- マージコミットの差分は、最初の親コミットと比較します。
- 競合中のUnstaged差分は、自分側の内容と現在の作業ファイルを比較します。共通の祖先・自分側・相手側を並べる表示はありません。
- bareリポジトリでは、履歴とコミット済みファイルのみ閲覧できます。
- シンボリックリンクはリンク先の文字列のみ表示します。作業ツリーの`.git`やリポジトリ外のファイルは閲覧できません。

## Development

RustのCLIとHTTPサーバーをルートに、Vite+・React・TypeScriptを`frontend/`に置きます。
frontendはpnpmで依存を固定し、`vp`で開発・ビルド・テスト・lint・formatを実行します。
Gitへのアクセスにはgit2-rsと同梱したlibgit2を使います。
frontendの生成物はrust-embedで実行ファイルへ埋め込みます。

以下のコマンドは、gittoをcloneしたディレクトリで実行します。

### Development

```sh
nix develop
(cd frontend && pnpm install --frozen-lockfile && pnpm exec vp build)
cargo build
```

HMRを使う場合は、まず別ターミナルで開発用のバックエンドをフォアグラウンド起動します。`--server`は内部・開発用オプションで、この場合だけCtrl+Cまで動き続けます。
同じポートのバックグラウンドサーバーが残っている場合は、その閲覧を明示終了してから起動してください。

```sh
cargo run -- --server
```

もう一つのターミナルでリポジトリを登録し、Viteを起動します。

```sh
cargo run -- . --no-open
cd frontend
pnpm exec vp dev
```

表示されたURLのポートだけを47319から5173に変え、`http://127.0.0.1:5173/r/<ID>/`を開きます。
Viteがリポジトリごとの`/r/<ID>/api/`をRustへプロキシします。バックエンドを再ビルドした場合は、フォアグラウンドのサーバーを再起動してください。

### Build and checks

```sh
nix flake check
nix build
```
