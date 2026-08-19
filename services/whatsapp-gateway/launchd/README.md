# Auto-restart do piloto (launchd, macOS)

Estes dois agentes existem porque o piloto **não** roda numa VPS com Docker: ele
roda no Mac. Sem eles, qualquer queda — reboot, crash, `kill` acidental — deixa o
WhatsApp da empresa fora do ar até alguém perceber. O vigia no banco avisa a
gestão, mas não conserta nada sozinho.

| Agente | O que mantém de pé |
|---|---|
| `br.com.aelbra.whatsapp-gateway` | o serviço Node (Baileys) na porta 3000 |
| `br.com.aelbra.whatsapp-ngrok` | o túnel HTTPS com **domínio fixo** |

## Por que o domínio fixo é inegociável

O Supabase guarda a URL do gateway num secret. Se o endereço mudar, mensagem
continua **entrando** (o gateway fala de dentro para fora), mas **resposta e
comando de sessão param**. É falha silenciosa — a pior possível aqui. Com o
túnel fora do ar, a borda do ngrok responde `404`, não erro de conexão.

O domínio mora em `~/Library/Application Support/ngrok/ngrok.yml`, junto com o
authtoken. Esse arquivo **não** vai para o git.

## Instalar

```bash
cp services/whatsapp-gateway/launchd/*.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/br.com.aelbra.whatsapp-gateway.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/br.com.aelbra.whatsapp-ngrok.plist
```

## Operar

```bash
launchctl print gui/$(id -u)/br.com.aelbra.whatsapp-gateway   # estado, pid, exit
launchctl kickstart -k gui/$(id -u)/br.com.aelbra.whatsapp-gateway   # reiniciar
tail -f ~/Library/Logs/whatsapp-gateway/gateway.log           # logs ao vivo
```

## Recuperação medida (2026-08-19)

| Cenário | `/saude` público voltou em |
|---|---|
| `kill -9` no gateway | 2 s |
| `kill -9` no ngrok | 1 s |
| `kill -9` nos dois juntos | 3 s |
| `bootout` + `bootstrap` dos dois | 2 s |

## Limitação conhecida, que não dá para contornar aqui

`LaunchAgent` roda na **sessão do usuário**. Se o Mac reiniciar e ninguém fizer
login, nada sobe. Também não há nada de pé com a máquina desligada ou sem rede.
Isso é o custo de o piloto morar num Mac em vez de numa VPS — e é o principal
motivo para migrar antes de ligar o segundo número.
