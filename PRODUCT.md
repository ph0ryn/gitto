# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vite+・React・TypeScriptでbrowser UIを作り、pnpmで依存を管理する。RustがAPIと同梱したfrontendを配信する。

## Users

開発者が、手元のGitリポジトリをブラウザーで素早く読み解くために使う。

## Product Purpose

ローカルリポジトリの履歴、ツリー、ファイル内容、作業ツリーの変更を一つの読み取り専用画面で確認できるようにする。成功は、`gitto .` で起動して現在のリポジトリを迷わず閲覧できること。

## Positioning

GitHubの閲覧体験に近い馴染みやすさを保ちながら、ローカルのstaged、unstaged、untracked、conflictsを同じ画面で確認できる。

## Operating Context

ターミナルから `gitto .` を実行し、開いたローカルブラウザーでリポジトリを閲覧する。画面は読み取り専用で、必要なときに更新ボタンを押して状態を再取得する。

## Capabilities and Constraints

コミット履歴、ブランチ、ファイルツリー、コミットまたは作業ツリーのファイル内容、staged／unstaged／untracked／conflictsの状態とパッチを表示する。HEADが未作成のリポジトリでは履歴とツリーを空状態で表示する。APIエラー、読み込み中、空状態を画面で説明する。Gitへの書き込み操作は提供しない。

## Brand Commitments

製品名とCLI名は `gitto`。ユーザー画面は自然な日本語で、GitHubに近い落ち着いたrepo browserとする。

## Product Principles

- リポジトリの事実を最短距離で見せる。
- 読み取り専用であることを操作から明確にする。
- 履歴、ツリー、変更を同じ文脈で行き来できる。
- 失敗や空状態を隠さず、次の行動を示す。

## Accessibility & Inclusion

キーボード操作可能な標準コントロール、明確なフォーカス表示、十分なコントラスト、レスポンシブなレイアウトを維持する。
