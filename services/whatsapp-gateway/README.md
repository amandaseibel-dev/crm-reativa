# Espelho do WhatsApp — Central do ReATIVA One

Serviço isolado que mantém a conexão dos números de WhatsApp por QR Code e
entrega tudo que chega para o CRM. **Não é parte do CRM**: roda em VPS própria,
em Docker, 24/7.

```
WhatsApp  ->  este serviço (VPS/Docker)  ->  Edge Function  ->  Supabase  ->  Central do ReATIVA One
```

O CRM continua sendo a única tela que o operador usa. Ninguém abre WhatsApp Web,
ninguém escaneia QR além da gestão, e a conexão pertence ao servidor.

---

## O que este serviço NÃO faz

- **Não guarda conversa.** Mensagem que chega é repassada e apagada da fila
  assim que o CRM confirma que gravou. Se esta máquina for invadida, não há
  histórico de aluno nela.
- **Não tem credencial do banco.** Fala com uma Edge Function assinando com
  HMAC. Invadir a VPS não dá acesso ao Supabase.
- **Não faz disparo em massa, grupo nem lista de transmissão.** Escopo é
  atendimento receptivo 1:1.

---

## Limitações que precisam ser conhecidas antes de ligar

| Limitação | Consequência prática |
|---|---|
| O histórico só vem **no pareamento**, e a quantidade não é garantida | O que não for capturado ao ler o QR **não volta**. O pedido posterior de "manda o resto" é ignorado pelo WhatsApp para dispositivo vinculado. |
| Cada conta permite **4 aparelhos vinculados** | Este serviço ocupa 1. Se a operação continuar abrindo WhatsApp Web em várias máquinas, pode **expulsar** esta sessão. Desconecte as outras antes. |
| Conexão não oficial | Uso fora dos termos do WhatsApp. O risco assumido, e registrado, é o número ser bloqueado. |
| Mensagem de grupo pode não ser roteada | Fora do escopo desta fase de qualquer forma. |
| Contatos que chegam como `@lid` | Não trazem telefone; são ignorados e registrados no log. |

**Consequência de projeto:** o serviço já nasce gravando o histórico. Nunca leia
o QR de um número novo antes de conferir que o serviço está no ar e que o canal
correspondente existe em `whatsapp_canais`.

---

## Instalação na VPS

Pré-requisitos: Docker e Docker Compose.

```bash
git clone <repo> && cd services/whatsapp-gateway
cp .env.example .env
```

Gere os dois segredos:

```bash
openssl rand -hex 32   # CRM_SEGREDO
openssl rand -hex 32   # GATEWAY_TOKEN
```

Preencha o `.env` e registre os MESMOS valores no Supabase:

```bash
supabase secrets set WHATSAPP_GATEWAY_SEGREDO=<CRM_SEGREDO> --project-ref ahattpqrjmhkzsmnbdzs
supabase secrets set WHATSAPP_GATEWAY_TOKEN=<GATEWAY_TOKEN> --project-ref ahattpqrjmhkzsmnbdzs
supabase secrets set WHATSAPP_GATEWAY_URL=https://wa.seudominio.com.br --project-ref ahattpqrjmhkzsmnbdzs
```

Suba:

```bash
docker compose up -d --build
docker compose logs -f
```

### Rodando sem Docker (Node direto)

O `docker-compose.yml` injeta o `.env` pelo `env_file`. **Rodando com Node
direto isso não acontece** — o Node ignora o `.env` a menos que você peça:

```bash
node --env-file=.env src/index.js
```

Sem a flag, o serviço morre no start com `ENOENT: mkdir '/dados'`, porque cai no
`DADOS_DIR` padrão do container.

**Atenção:** neste modo não existe reinício automático. `restart: always` é do
compose. Se a máquina reiniciar ou o terminal fechar, o gateway não volta
sozinho — ver seção seguinte.

### Sobreviver a reboot da VPS (não é só `restart: always`)

`restart: always` no compose faz o container voltar se o processo morrer. **Não
basta para reboot da máquina**: se o serviço do Docker não estiver habilitado no
boot, a VPS reinicia e o gateway simplesmente não sobe — e ninguém percebe até
alguém olhar a Central.

```bash
sudo systemctl enable --now docker
```

Confira e teste de verdade antes de parear qualquer número:

```bash
systemctl is-enabled docker && sudo reboot
```

Depois do reboot, sem tocar em nada, o container tem que estar de pé:

```bash
docker ps --filter name=whatsapp-gateway && curl -s localhost:3000/saude
```

### Firewall

A porta 3000 já é publicada apenas em `127.0.0.1`, então não fica exposta. Ainda
assim, deixe aberto só o necessário:

```bash
sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

### Proxy reverso (obrigatório)

O container publica apenas em `127.0.0.1:3000`. Quem termina HTTPS é o proxy —
sem ele, o token de comando trafega em texto claro. Com Caddy é uma linha:

```
wa.seudominio.com.br {
    reverse_proxy 127.0.0.1:3000
}
```

### Volume: o item mais importante da instalação

`/dados` guarda a credencial da sessão e a fila de reenvio. **Apagar o volume =
reparear o número = perder para sempre a sincronização inicial dele.** O volume
`whatsapp-dados` do compose existe para isso. Há cópia da credencial no Postgres
para o caso de VPS nova, mas não conte com ela como rotina.

---

## Ligando o primeiro número

1. Cadastre o canal na Central (gestão): apelido, número e `sessao_chave` —
   a chave precisa ser **idêntica** à de `SESSOES` no `.env`.
2. No celular, **desconecte todas as outras sessões** de WhatsApp Web.
3. Confirme nos logs que a sessão subiu e o status virou `AGUARDANDO_QR`.
4. Leia o QR pela Central (só gestão vê; a leitura fica registrada).
5. Acompanhe o painel de sincronização: ele mostra conversas, mensagens e
   pendências resgatadas.

Ligue **um número por vez**. O segundo só depois do primeiro estável.

---

## API de controle

Só a Edge Function chama. Tudo exige `Authorization: Bearer $GATEWAY_TOKEN`,
menos `/saude`.

| Rota | O que faz |
|---|---|
| `GET /saude` | Healthcheck do Docker. Estado das sessões e tamanho da fila. |
| `GET /sessoes` | Estado de cada sessão. |
| `POST /enviar` | `{sessao, telefone, texto}` — envia e devolve o id da mensagem. |
| `POST /sessao/:chave/reconectar` | Força reconexão. |
| `POST /sessao/:chave/desconectar` | Fecha a sessão sem desvincular. |
| `POST /sessao/:chave/logout` | **Desvincula** o aparelho. Só volta com QR novo. |

---

## Resiliência: o que acontece quando dá errado

| Situação | Comportamento |
|---|---|
| Internet cai | Reconexão com espera crescente (2s → 5min). Nada se perde. |
| Supabase fora do ar | Mensagens ficam na fila em disco e são entregues quando voltar, na ordem. |
| Container reiniciado | Credencial vem do volume; a sessão volta sozinha, sem QR. |
| VPS nova / volume perdido | Credencial é restaurada do Postgres. |
| Sessão expirada ou derrubada no celular | Status `PAREAMENTO_NECESSARIO` e QR novo na Central. |
| Outro aparelho assume a sessão | Status `ERRO` e **não** reconecta sozinho — reconectar viraria cabo de guerra entre os dois. Desconecte o outro e clique em reconectar. |
| Processo travado sem morrer | O batimento para, o CRM mostra o canal fora do ar, e o vigia reinicia a sessão em 10 min. |

Uma queda **nunca** apaga mensagem já gravada no CRM: o histórico vive no
Supabase, não na sessão.

---

## Logs

JSON estruturado, um campo `sessao` em cada linha. Conteúdo de mensagem **nunca**
é logado (LGPD) — o log diz o que aconteceu, não o que a pessoa escreveu.

```bash
docker compose logs -f | grep '"sessao":"cobranca"'
```

---

## Por que a versão do Baileys está fixa

`package.json` fixa `baileys` em **6.7.24** (a linha `legacy`, estável), sem
`^`. Dois motivos:

1. O `latest` do npm hoje aponta para `7.0.0-rc14`, um **release candidate**.
2. Existe uma `6.17.16` publicada fora de ordem (março/2025). Com `^6.7.24` o
   npm resolveria justamente para ela — uma build mais velha com número maior.

Ao atualizar, confira as duas coisas de novo.
