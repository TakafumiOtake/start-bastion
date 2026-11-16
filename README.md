# start-bastion

プライベートサブネットのEC2を必要に応じて起動し、Session Managerで手元のポートをPostgreSQLの5432番へ転送します。

## 手元の準備

Node.js 24以降とAWS CLIを用意し、対象環境のAWSプロファイルで認証を済ませます。ポート転送にはSession Manager pluginも必要です。macOSでHomebrewを使う場合は、次のコマンドでインストールできます。

```sh
brew install --cask session-manager-plugin
```

インストール後、次のコマンドでバージョンが表示されることを確認します。

```sh
session-manager-plugin --version
```

Windows、Linux、macOS用のインストーラーを使う場合は、AWSの手順を参照してください。[AWSのOS別インストール手順](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) ・ [Homebrewのパッケージ](https://formulae.brew.sh/cask/session-manager-plugin)

## 接続する

リポジトリのディレクトリで依存パッケージをインストールし、設定例をコピーします。

```sh
npm install
cp .env.example .env
```

`.env`を開き、AWSプロファイル、リージョン、踏み台EC2のNameタグ（`BASTION_INSTANCE_NAME`）、専用SSMドキュメント名（`SSM_DOCUMENT_NAME`）を自分の環境に合わせてください。Nameタグは対象リージョン内で踏み台を一意に特定できる値を使います。

```sh
npm run start-bastion
```

このコマンドは起動時に`.env`を読み込みます。シェルで設定済みの環境変数が優先され、環境変数だけでの起動も可能です。トンネルが開いたら、DBクライアントから手元のローカルポート（設定例では`localhost:15432`）に接続します。DBの認証情報はクライアント側で用意してください。

Ctrl+Cで転送を終了します。EC2の停止は別途行ってください。

## AWS側の前提

踏み台にはSSM Agent（3.1.1374.0以降）とSystems Managerへの通信経路が必要です。踏み台からDBエンドポイントを名前解決でき、TCP 5432で接続できることも確認してください。利用者には対象EC2の起動・状態確認、対象EC2と転送ドキュメントでのSSMセッション開始、データチャネル接続などの権限が必要です。

管理者は、環境ごとに `documentType: Session`、`sessionType: Port` のドキュメントを作成します。以下はその内容の例です。`host` を対象のDBクラスターのエンドポイントに置き換えてください。

```json
{
  "schemaVersion": "1.0",
  "sessionType": "Port",
  "parameters": {
    "localPortNumber": { "type": "String", "default": "15432", "allowedPattern": "^[0-9]{1,5}$" }
  },
  "properties": {
    "type": "LocalPortForwarding",
    "host": "example.cluster-xxxxxxxxxxxx.ap-northeast-1.rds.amazonaws.com",
    "portNumber": "5432",
    "localPortNumber": "{{ localPortNumber }}"
  }
}
```
