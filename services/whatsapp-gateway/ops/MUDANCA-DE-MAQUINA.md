# Mudança de máquina do gateway (e o Mac como reserva)

Roteiro para tirar o gateway do notebook da Amanda e colocá-lo numa máquina que
fica ligada. Escrito depois do apagão de 20/08/2026, em que o Piloto ficou 22
minutos fora porque a tampa do MacBook foi fechada.

## Por que sair do notebook

O serviço está instalado como **LaunchAgent**, que roda na sessão do usuário.
O canal só existe quando TRÊS coisas valem ao mesmo tempo:

1. máquina ligada;
2. sessão da Amanda logada — sem login, LaunchAgent não sobe;
3. máquina acordada — tampa fechada congela o processo inteiro.

Nenhuma delas se sustenta num notebook que vai para casa todo dia.

## A regra que não pode ser quebrada

**Nunca duas instâncias no ar ao mesmo tempo.** As duas usam a MESMA credencial
e se derrubam com `connectionReplaced` (440); a política de queda então PARA a
sessão e espera um humano. Uma máquina de cada vez, sempre.

## A armadilha da credencial (leia antes de acionar a reserva)

`authState.js` lê a credencial **preferindo o disco**, e só cai no Postgres
quando não há arquivo local. Isso está certo dentro de uma máquina — ali o disco
nunca está mais velho que o banco, porque grava-se no disco primeiro.

**Essa invariante não atravessa duas máquinas.** Quando a máquina nova assumir,
ela gira as chaves e atualiza o Postgres; o `dados/sessoes/piloto.json` do Mac
congela e envelhece. Subir o Mac depois disso faz ele preferir o arquivo velho e
ignorar a credencial boa — sessão rejeitada, no pior caso QR novo. E reparear
consome a ÚNICA chance de sincronização inicial daquele número.

## Migração (máquina nova)

1. Instalar Docker. Copiar o repositório e o `.env`.
   O `.env` não contém senha de banco — só `CRM_URL`, `CRM_SEGREDO`,
   `GATEWAY_TOKEN`, `SESSOES`, `PORTA`, `DADOS_DIR`, tempos.
2. Conferir `SESSOES`. Hoje vale `SESSOES=piloto,comercial`: o Comercial foi
   repareado em 24/08/2026 e voltou à operação. Se algum canal estiver banido
   (403 permanente), tirá-lo da lista — banido só consome tentativa de
   reconexão, e deixá-lo fora encerra o loop.
3. **NÃO copiar `dados/sessoes/*.json`.** Disco vazio faz o serviço buscar a
   credencial fresca do Postgres — é assim que se entra sem QR.
4. Publicar a porta 3000 atrás de HTTPS (Caddy/nginx) e apontar o CRM para a
   URL nova. Some o túnel do ngrok.
5. **Parar o gateway do Mac ANTES de subir o novo:**
   `launchctl bootout gui/$UID/br.com.aelbra.whatsapp-gateway`
6. `docker compose up -d` e conferir `curl -s localhost:3000/saude`
   → `piloto: CONECTADO`.

## O Mac como reserva fria

Fica instalado e pronto, com o serviço DESLIGADO. Para acioná-lo:

1. parar o gateway da máquina da empresa (`docker compose down`);
2. no Mac, tirar a credencial velha do caminho:
   `mv dados/sessoes/piloto.json dados/sessoes/piloto.json.velho`
3. subir: `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/br.com.aelbra.whatsapp-gateway.plist`
4. conferir `/saude`.

Para voltar à máquina da empresa, o mesmo caminho ao contrário — sempre parando
uma antes de subir a outra.

## Não apagar

- `dados/fila-suspensa/comercial/` — 38.661 itens congelados do canal banido.
- `dados/lid-sem-vinculo-*.json` — mensagens de histórico sem vínculo
  LID→telefone, guardadas de propósito para reprocessar.
- `dados/backup-credenciais/`.

## Diagnóstico rápido quando "o Piloto caiu"

1. `pmset -g log | grep -E "Entering Sleep|Wake from"` (se ainda no Mac);
2. silêncio simultâneo das DUAS sessões e do vigia no log = máquina, não código;
3. `curl -s localhost:3000/saude` mostra o estado real por sessão.

---

# Caminho escolhido: Fly.io

Decidido em 20/08/2026, depois que a máquina da empresa se mostrou inviável —
Windows travado pelo TI, sem permissão para instalar Docker, Node ou ngrok.

A Fly resolve as três amarras de uma vez: não há tampa para fechar, não há
bateria para acabar, não há sessão de usuário para deslogar. E o endereço
público com HTTPS vem junto, o que **aposenta o ngrok**.

Configuração em `fly.toml`, ao lado deste arquivo. Custo estimado US$ 6–8/mês
(máquina 1 GB + volume 1 GB); confira em fly.io/pricing, preço de nuvem muda.

## Contratar (uma vez)

1. Conta em <https://fly.io/app/sign-up> — e-mail ou GitHub.
2. **Cartão de crédito é obrigatório**, mesmo no menor plano. Cobrança em
   dólar: o extrato vem com IOF e câmbio.
3. `flyctl` no Mac da Amanda (a máquina dela, onde há permissão):
   `brew install flyctl` e depois `fly auth login`.

## Subir (uma vez)

Tudo a partir de `services/whatsapp-gateway`:

```
fly launch --no-deploy --copy-config --name reativa-whatsapp-gateway --region gru
fly volumes create whatsapp_dados --region gru --size 1
fly secrets set CRM_URL=... CRM_SEGREDO=... GATEWAY_TOKEN=...
```

Os três segredos são os MESMOS do `.env` de hoje. Nenhuma credencial de banco
vai para a Fly: o gateway só fala com as Edge Functions.

**PARAR O MAC ANTES DE FAZER O DEPLOY.** Duas instâncias com a mesma
credencial se derrubam com `connectionReplaced` (440), e a política de queda
PARA a sessão esperando um humano:

```
launchctl bootout gui/$UID/br.com.aelbra.whatsapp-gateway
launchctl bootout gui/$UID/br.com.aelbra.whatsapp-ngrok
```

Só então:

```
fly deploy
fly scale count 1      # UMA instância, sempre
fly status             # tem de listar exatamente 1 machine
```

## NÃO copiar a credencial

Não suba `dados/sessoes/piloto.json`. O volume nasce vazio, e é isso que faz o
serviço buscar a credencial **fresca do Postgres** e entrar sem QR. Copiar o
arquivo faz ele preferir o disco — e um arquivo que envelheceu custa um
repareamento, que gasta a única sincronização inicial daquele número.

## Apontar o CRM para a Fly

Trocar UM secret no Supabase:

```
WHATSAPP_GATEWAY_URL = https://reativa-whatsapp-gateway.fly.dev
```

`WHATSAPP_GATEWAY_TOKEN` e `WHATSAPP_GATEWAY_SEGREDO` não mudam.

Enquanto esse secret não for trocado, o sintoma é traiçoeiro e já foi visto
antes: mensagem continua ENTRANDO (o gateway fala de dentro para fora), mas
resposta e comando de sessão param. Falha silenciosa.

## Teste de fumaça (na ordem)

1. `fly logs` → `sessao conectada`, e **nenhuma** linha de QR.
2. `curl -s https://reativa-whatsapp-gateway.fly.dev/saude`
   → `piloto: CONECTADO`, `temQr: false`.
3. Mandar uma mensagem pela Central e ver chegar no celular.
4. Responder do celular e ver aparecer na Central.
5. **Fechar o MacBook e repetir 3 e 4.** É este passo que prova que a
   dependência acabou — o motivo de toda a mudança.

## Voltar para o Mac, se precisar

Mesma regra ao contrário, sempre uma máquina de cada vez:

1. `fly scale count 0`
2. no Mac: `mv dados/sessoes/piloto.json dados/sessoes/piloto.json.velho`
3. `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/br.com.aelbra.whatsapp-gateway.plist`
   e o mesmo para o agente do ngrok
4. devolver o `WHATSAPP_GATEWAY_URL` para o domínio do ngrok
5. conferir `/saude`
