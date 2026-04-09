## INITIALIZATION
`daml/Main.daml` has a script that runs on `daml start` which creates the parties on the ledger. 

`daml.yaml` has the following configuration to run the script on startup:

```yaml
init-script: Main:setup
ledger:
  host: localhost
  port: 6865
```