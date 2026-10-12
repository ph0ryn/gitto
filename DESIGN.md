---
name: gitto
description: 明るい室内でローカルGitを読む読み取り専用開発ツール
colors:
  primary: "#245cc5"
  surface: "#fff"
  sidebar: "#f5f6f8"
  history-surface: "#fafbfc"
  ink: "#293241"
  tree-ink: "#475367"
  muted: "#606b7b"
  line: "#e2e6ec"
  selection: "#e8eefb"
  hover: "#edf0f5"
  modified: "#91630c"
  added: "#247345"
  untracked: "#526c5e"
  deleted: "#bd3545"
typography:
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif'
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.5
  metadata:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif'
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.85
rounded:
  control: "6px"
  button: "5px"
  row: "4px"
  badge: "4px"
  source: "3px"
  hairline: "1px"
spacing:
  compact: "8px"
  pane-inset: "16px"
  code-inset: "20px"
  footer: "32px"
components:
  branch-select:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "34px"
    padding: "0 8px"
  icon-button:
    textColor: "{colors.muted}"
    rounded: "{rounded.button}"
    size: "30px"
  selected-row:
    backgroundColor: "{colors.selection}"
    rounded: "{rounded.row}"
    height: "30px"
  code-surface:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    padding: "0 20px"
---

# Design System: gitto

## Overview

gittoは、明るい室内で開発者がローカルGitを読み解くような、落ち着いた開発ツールである。白い本文を中心に、左の薄い灰色のファイルレール、白いChanges、オフホワイトのHistoryを細い境界線で分ける。情報密度は高く保つが、カードや大きな装飾で閲覧の流れを遮らない。

ファイル、本文、変更、履歴の4ペインを同じ視線上に置き、選択中の対象だけを青い面で示す。Gitの状態色は選択中も意味を保つ。UIのラベル、案内、エラーは英語で表示し、ファイル内容とコミットメッセージは原文のまま扱う。ファイルとフォルダのアイコンは、npmで管理するCatppuccin Iconsを16pxで表示し、白い作業面に合わせてLatteの配色を使う。操作ボタンは既存のインラインSVGを保つ。

**Key Characteristics:**

- 白いviewerを中心にした明るい作業面
- 薄い灰色のfiles、白いchanges、オフホワイトのhistory
- 細い境界線、固定された4ペイン、独立したスクロール
- 13pxのUI、11pxのmetadata、11px/1.85のコードと差分
- 青い選択・focusと、選択中も保たれるGit状態色
- 読み取り専用と、空状態・エラーを隠さない案内

## Colors

白を本文の基準にし、薄い中性色でレールと履歴を分ける。青は選択とfocusだけに使い、Gitの状態色は対象の状態を伝えるために残す。

### Primary

- **作業面の青** (`#245cc5`): 選択状態、focus輪郭、選択中のcommit dotを示す。

### Neutral

- **本文の白** (`#fff`): viewerと標準コントロールの背景。
- **ファイルレール** (`#f5f6f8`): 左のfiles、差分の省略区間、補助バッジの背景。
- **履歴のオフホワイト** (`#fafbfc`): historyと行番号gutterの背景。
- **本文のインク** (`#293241`): UI見出し、本文、選択された履歴行の文字。
- **ツリーのインク** (`#475367`): 通常のファイル名とhashの文字。
- **補助テキスト** (`#606b7b`): metadata、行番号、境界に近い説明。
- **細い境界線** (`#e2e6ec`): ペイン、見出し、行番号、差分区間の区切り。
- **選択の青面** (`#e8eefb`): ファイル、変更、履歴の選択背景。
- **hoverの灰面** (`#edf0f5`): 未選択の行と小さな操作ボタンのhover。

### Semantic status

- **変更の黄** (`#91630c`): modifiedのファイル名と通常viewerの変更マーク。
- **追加の緑** (`#247345`): addedのファイル名、追加行、追加数。
- **未追跡のくすみ緑** (`#526c5e`): untrackedのファイル名。
- **削除の赤** (`#bd3545`): deletedとconflictedのファイル名、削除行、エラーに関係する状態。

**The Preserve-Meaning Rule.** 選択の青面はGit状態色を上書きしない。状態色は名前とマークに残し、選択は背景で示す。

## Typography

**UI Font:** `-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif`
**Code Font:** `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

システムsansは見出し、操作、ファイルツリー、履歴の説明に使い、monoはviewerとdiffの内容、hashに使う。UIは13px、metadataは11px、コードと差分は11px/1.85で、長い内容の読みやすさと桁の揃いを優先する。

### Hierarchy

- **UI** (400–600, 13px): ペイン見出し、ブランチselect、ファイルツリー、履歴message。Filesはブランチ見出し直下の補助toolbarとして11pxを使う。
- **Metadata** (400–500, 11px): 件数、author、date、補助説明。hashも11pxのmonoで表示する。
- **Code** (400, 11px, 1.85): viewerとdiffのソース、patch、行番号。

**The Quiet Hierarchy Rule.** 見出しは本文を圧迫せず、historyではmessageを最初に、hash・author・dateを補助行として読ませる。

## Layout

左からfiles、viewer、changes、historyの4ペインを置く。基準幅は220px、viewerは360px以上の可変幅、changesは260px、historyは260pxである。各ペインは境界を保ったまま内部だけがスクロールし、本文の増加で隣の境界を動かさない。

見出しは52px、filesの補助toolbarは38px、ツリー行は30px、footerは32px以上である。viewerの見出しでは親パスをmutedにし、filenameをsemiboldで表示する。footerは画面全幅に残り、左にrepository path、閲覧中のHEADまたはcommit位置、開いているファイルのサイズを区切り付きで示す。右にはGitto、読み取り専用の説明、バージョンを並べる。バージョンは起動したCLIの`Cargo.toml`から取得する。

狭い画面では4ペインを縦積みにせず、workspaceだけを水平にパンする。footerは全幅を保ち、収まらない場合は右の製品情報を次の行へ折り返す。長いrepository pathは省略し、600px以下では左右paddingとmetadata間隔を狭める。画面全体の縦スクロールは発生させない。

## Elevation & Depth

影は使わず、白、薄灰、オフホワイトの面と1pxの境界線で深さをつくる。選択とhoverは面の色だけを短く変え、ペインの構造やスクロール位置を動かさない。

### Motion Vocabulary

- **短い状態遷移** (`120ms ease`): button、select、summaryのbackground、color、border-colorに使う。
- **Reduced motion**: `prefers-reduced-motion: reduce`では上記のtransitionを無効にする。

**The Stable Boundary Rule.** プレビューの切り替えはviewerの内容だけを置き換え、4ペインの境界を動かさない。

## Shapes

ペインと見出しは直線的に組み立て、境界は1pxにする。branch selectは控えめな6px、icon buttonと履歴行は5px、ツリー行と件数バッジは4pxの角丸である。空状態はアイコンやplaceholder markを置かず、短い見出しと説明で示す。

## Components

### Branch selector

- **Shape:** 標準のselectに6pxの角丸、34pxの高さ、左右8pxのpadding。
- **Color:** 左のfilesレール上で白いsurfaceを使い、1pxの控えめな境界線を置く。
- **Behavior:** branch名、HEAD、閲覧中のcommitを1つのselectで選ぶ。commitからbranchまたはHEADを選ぶと、そのrevisionのツリーと履歴へ戻る。

### File tree and change tree

- **Shape:** 30pxの行、階層ごとの16pxインデント、細いguide line。
- **Color:** 通常名はtree-ink、Git状態はmodified／added／untracked／deletedの色、選択はselection面で示す。
- **Behavior:** folderはその場で展開し、兄弟項目とviewerを保つ。ChangesはTracked、Untracked、またはCommitの階層を表示する。変更状態はファイル名の色で示し、追加・削除数の右に読み取り専用のstaged checkboxを置く。stagedだけをcheckedにし、Commitではcheckboxを表示しない。
- **Interaction:** 行の選択でviewerにfileまたはdiffを開く。別の内容ボタンは置かない。

### Viewer heading and source

- **Shape:** 52pxの固定headingと、その直下から始まるscrollable content。
- **Color:** 親パスはmuted、filenameはsemibold。本文は白、line number gutterはhistory-surface。
- **Behavior:** fileを開くと右端にclose buttonを表示し、何も開いていないときはheadingを空にする。ソースはsyntax highlight、左gutterの行番号、直近の比較基準に対応した変更マークを持つ。
- **Code:** sourceとdiffはmono 11px/1.85。diffは一つのsource列で、旧行番号・新行番号・記号をgutterに保つ。

### History

- **Shape:** 5pxの角丸行、上下12px・左右10pxのpadding。
- **Hierarchy:** summary messageを13pxの主情報、hashとauthorを11pxの補助行、dateを11pxの独立行として表示する。
- **State:** 選択行はselection面とaccentのcommit dotで示し、load-moreはsurfaceと細い境界線で置く。
- **Navigation:** コミット閲覧中は、固定見出し行にCommits、Back to HEAD、件数の順で表示する。復帰操作は現在のHEADを読み直し、コミットの選択を解除して作業ツリーの表示へ戻る。閲覧中のhashはフッターに表示する。

### Controls and states

- **Icon button:** 30px四方、5pxの角丸、透明な通常面。既存のclose／refreshなどのインラインSVGだけを使い、新しいアイコンセットは導入しない。
- **Status and paging:** stage状態は標準のdisabled checkboxで表示する。Load moreはsurfaceの小さなbuttonとして置き、hoverではhover面と本文色に変える。
- **Focus:** キーボードfocusは2pxのaccent輪郭で示し、disabled controlは操作不可と半透明で示す。
- **Empty and error:** viewerの空状態タイトルは18px、補助ペインでは14pxを使う。empty state、loading、API errorは英語の短い見出しと説明で示す。Gitや作業ツリーを書き換える操作は提供しない。

## Do's and Don'ts

- **Do** 内容が増えても4ペインの境界、独立スクロール、footerの位置を保つ。
- **Do** viewerのheadingでは親パスをmuted、filenameをsemiboldにし、historyではmessage、hash・author、dateの順で階層を作る。
- **Do** 選択中もGit状態色を保ち、選択の青面で対象を区別する。
- **Do** 変更一覧の更新失敗を表示し、開いている本文と選択状態を保持する。
- **Do** UIを英語にし、repository contentsとcommit messagesを原文のまま表示する。
- **Don't** ブランチ名や製品名を補助行に繰り返さない。
- **Don't** ファイルとフォルダ以外へアイコンセットを広げず、placeholder empty mark、装飾的なカードや影を追加しない。
- **Don't** Gitやファイルを書き換える操作を追加しない。
