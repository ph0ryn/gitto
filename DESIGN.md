---
name: gitto
description: 白基調の読み取り専用Gitワークスペース
colors:
  primary: "#0969da"
  surface: "#ffffff"
  sidebar: "#f8f9fb"
  ink: "#24292f"
  muted: "#59636e"
  line: "#dfe3e8"
  selection: "#e9f2ff"
  modified: "#9a6700"
  added: "#1a7f37"
  untracked: "#617267"
  deleted: "#cf222e"
typography:
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif'
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.8
rounded:
  control: "3px"
spacing:
  compact: "8px"
  inset: "14px"
  code: "24px"
components:
  icon-button:
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    size: "28px"
  selected-row:
    backgroundColor: "{colors.selection}"
    textColor: "{colors.muted}"
---

# Design System: gitto

## Overview

白い本文と淡い中性色の操作欄を、細い境界線で分ける。
ファイルや差分の閲覧に必要な情報を優先し、装飾的なヘッダーやカードを置かない。
ブランチ名は選択欄だけに表示する。
UIのラベル、案内、エラーは英語に統一し、ファイル内容とコミットメッセージは原文を保つ。

## Colors

青は選択背景とフォーカスに使う。本文・補助情報・境界線は中性色で区別する。
ツリーの変更は黄系、追加は緑、未追跡は薄いくすんだ緑、削除・競合は赤で示す。
変更のない名前は少し薄いグレーにする。
フォルダーにも配下の変更を反映し、選択中も名前の色を保つ。
左のファイルツリーはHEADまたは現在のチェックアウト先を閲覧しているときだけ色を付ける。
差分の追加・削除とエラーにも、既存の意味に対応する緑・赤を使う。

## Typography

操作にはシステムのサンセリフを使い、ツリーの名前、コードとパッチには等幅書体を使う。
見出しは本文を圧迫しない大きさに抑え、数値は桁幅をそろえる。

## Layout

左からファイル、本文、変更、コミットの4欄を置く。
列幅は200px、最小300pxの可変幅、280px、230pxである。
見出しは44pxに固定し、内容は各欄の内部でスクロールする。
画面全体の縦スクロールは発生させない。
狭い画面ではワークスペースを横スクロールし、欄を縦に積まない。
28pxのフッターは画面全幅と最下部を保ち、リポジトリのパスと閲覧位置を表示する。

## Elevation & Depth

影は使わず、背景色と1pxの境界線で領域を分ける。

## Shapes

欄とヘッダーは直線的に構成する。小さな操作ボタンだけに控えめな角丸を使う。

## Components

ブランチは標準のselectで選ぶ。履歴の閲覧中はコミットを選択値にし、
元のブランチを選ぶことで先端へ戻れる。
本文は単一のviewerとし、全幅の固定ヘッダーに項目名と右端の閉じるボタンを置く。
何も開いていないときは、ヘッダーに名前やボタンを表示しない。
ファイルツリーのフォルダーはその場で展開し、本文と兄弟項目を保つ。
HEADまたはチェックアウト先では、未追跡と新規のローカルファイルをツリーに含める。
新規フォルダーは状態一覧のパスから展開し、更新後も既存の展開状態を保つ。
未追跡ファイルは作業ツリー、新規のステージ済みファイルはindexの内容を開く。
ツリー行は24pxとし、インデントと細いガイド線で階層を示す。
変更一覧はTrackedとUntrackedのフォルダー階層を表示し、単一のフォルダー列はまとめる。
Trackedの行には追加・削除数を表示する。ステージ済みはS、競合は!で区別する。
同じファイルのステージ済みと未ステージの差分は別の行として扱う。
変更行の選択で差分を開き、内容ボタンは置かない。
更新は変更一覧だけを取得し、本文・選択・スクロール位置を保つ。
キーボードフォーカスは2pxの輪郭で示し、操作中と無効状態を明示する。

## Do's and Don'ts

- 内容が増えても欄の境界とフッターを動かさない。
- 変更一覧の更新失敗を表示し、開いている本文を保持する。
- ブランチ名や製品名を補助行に繰り返さない。
- Gitやファイルを書き換える操作を追加しない。
