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
    textColor: "{colors.primary}"
---

# Design System: gitto

## Overview

白い本文と淡い中性色の操作欄を、細い境界線で分ける。
ファイルや差分の閲覧に必要な情報を優先し、装飾的なヘッダーやカードを置かない。
ブランチ名は選択欄だけに表示する。

## Colors

青は選択状態とフォーカスに使う。本文・補助情報・境界線は中性色で区別する。
差分の追加・削除とエラーには、既存の意味に対応する緑・赤を使う。

## Typography

操作にはシステムのサンセリフを使い、コードとパッチには等幅書体を使う。
見出しは本文を圧迫しない大きさに抑え、数値は桁幅をそろえる。

## Layout

左からファイル、本文、変更、コミットの4欄を置く。
列幅は200px、最小300pxの可変幅、210px、230pxである。
見出しは44pxに固定し、内容は各欄の内部でスクロールする。
画面全体の縦スクロールは発生させない。
狭い画面ではワークスペースを横スクロールし、欄を縦に積まない。
28pxのフッターは画面全幅と最下部を保ち、リポジトリのパスと閲覧位置を表示する。

## Elevation & Depth

影は使わず、背景色と1pxの境界線で領域を分ける。

## Shapes

欄とタブは直線的に構成する。小さな操作ボタンだけに控えめな角丸を使う。

## Components

ブランチは標準のselectで選ぶ。履歴の閲覧中はコミットを選択値にし、
元のブランチを選ぶことで先端へ戻れる。
本文のタブは表示中の項目だけを示し、未選択のタブは作らない。
変更一覧にはファイル名と親ディレクトリを表示し、同名ファイルを区別する。
更新は変更一覧だけを取得し、本文・選択・スクロール位置を保つ。
キーボードフォーカスは2pxの輪郭で示し、操作中と無効状態を明示する。

## Do's and Don'ts

- 内容が増えても欄の境界とフッターを動かさない。
- 変更一覧の更新失敗を表示し、開いている本文を保持する。
- ブランチ名や製品名を補助行に繰り返さない。
- Gitやファイルを書き換える操作を追加しない。
