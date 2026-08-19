# Central WhatsApp por QR Code — o que funciona, o que não funciona e como ligar

Documento de referência da operação e da implantação. Estado em 2026-08-18.

Arquitetura:

```
WhatsApp → espelho (Node + Baileys, VPS/Docker, 24/7) → Edge Function (HMAC)
         → Supabase → Central WhatsApp do ReATIVA One
```

O operador usa **só o CRM**. Ninguém abre WhatsApp Web, ninguém escaneia QR além
da gestão. A conexão pertence ao servidor, não à pessoa.

---

## 1. Limitações — leia antes de ligar

### 1.1 O histórico tem uma chance só, e não vem inteiro

Esta é a limitação mais importante do projeto.

O WhatsApp entrega histórico a um aparelho vinculado **apenas no momento do
pareamento**. A quantidade **não é documentada nem garantida** — é o que o
celular decidir empurrar. E o pedido posterior de "manda o resto"
(`fetchMessageHistory`) é **silenciosamente ignorado** para dispositivos
companheiros: o pedido sai, e nada volta.

O que costuma vir de forma confiável:

- lista de conversas recentes
- contatos que escreveram
- últimas mensagens de cada conversa, com data e hora
- o suficiente para deduzir **quem ficou sem resposta**

O que **não** vem: o arquivo completo do aparelho.

**Consequências práticas:**

- O espelho já nasce gravando tudo. Nunca leia o QR antes de o serviço estar no
  ar e o canal cadastrado.
- Se um número for repareado, aquela importação **não se repete**.
- Para recuperar mais do que veio: exportar a conversa pelo celular, uma a uma.
  É manual e não entra no CRM automaticamente.

### 1.2 Quatro aparelhos por conta

A conta permite 4 aparelhos vinculados. O espelho ocupa 1. Se a operação
continuar abrindo WhatsApp Web em várias máquinas, uma delas pode **expulsar** a
sessão do CRM. **Desconecte as outras sessões antes de parear.**

### 1.3 Conexão não oficial

Uso fora dos termos do WhatsApp. O risco assumido — e reafirmado pela Amanda em
2026-08-17 depois de apresentado três vezes — é o número ser bloqueado. A
diferença em relação a hoje: hoje o pior caso é a sessão cair; com automação o
pior caso é perder o número.

Mitigações no código: sem disparo em massa, sem grupo, `markOnlineOnConnect`
desligado, reconexão com espera crescente (nunca martelando), um número por vez.

### 1.4 Outras

| Limitação | Efeito |
|---|---|
| Contatos `@lid` | Não trazem telefone; são ignorados e ficam registrados no log. |
| Mensagem de grupo | Pode não ser roteada ao aparelho vinculado. Fora do escopo. |
| Mídia (fase 1) | Registra-se que veio foto/áudio/documento, com o tipo. O arquivo em si fica para a fase 2. |
| Status de entrega/leitura | Não capturado nesta fase. |

---

## 2. O que a janela de 24h deixou de ser

No caminho da Cloud API oficial havia uma regra de tarifação: fora de 24h só
passava modelo aprovado, e cobrado. **Isso não existe no caminho por QR Code.**
Não há template, não há custo por conversa, não há prazo para responder.

Toda a lógica de janela, `templates_habilitados` e liberação da gestão foi
**removida** — do banco, das funções e da tela.

O campo de resposta agora fecha por dois motivos reais, e ambos são explicados
ao operador: o **número está fora do ar**, ou a conversa está **finalizada**.

---

## 3. Como cada requisito foi atendido

| Pedido | Onde vive |
|---|---|
| Conexão por QR, 2 números, conectar/desconectar/reconectar | `whatsapp_canais` + serviço na VPS + `whatsapp-sessao` |
| Status de cada conexão | `conexao_status` + batimento; a Central só mostra "conectado" enquanto o sinal chega |
| Qual número recebeu / responder pelo mesmo | `canal_id` da conversa; o número de saída é **derivado no banco**, nunca escolhido pela tela |
| ~11 operadores sem WhatsApp Web | A sessão é do servidor; o operador usa o login do CRM |
| Caixa de entrada única | `whatsapp_conversas_listar` com os pseudo-status `SEM_RETORNO`, `NAO_LIDAS`, `SEM_RESPONSAVEL`, `MINHAS` |
| Contador e destaque de não lidas | `nao_lidas` + título da aba + selos na lista |
| Alerta sonoro | Gerado no navegador, ligado por botão (o navegador exige um clique antes) |
| Conversa não sai da fila só por ser lida | `whatsapp_marcar_lida` zera o não-lida e **nada mais**; `aguardando_resposta` continua |
| "Não lida" ≠ "aguardando resposta" | São duas colunas independentes, com filtros próprios |
| Responsável, assumir, transferir, retirar, filtrar | `responsavel_email/nome` + 3 RPCs; responder assume automaticamente |
| Identificação leve do aluno | `whatsapp_identificar_aluno` roda **uma vez**, quando a conversa nasce, e grava na conversa |
| Ambiguidade | Vira `AMBIGUO` com os candidatos guardados. A tela **pergunta**; nunca escolhe |
| Ficha sob demanda | `whatsapp_aluno_resumo`, chamada só quando a conversa é aberta |
| Histórico persistido | Mensagens no Supabase; a sessão é só transporte |
| Sincronização inicial e progresso | `whatsapp_sync_execucoes` + painel na supervisão |
| Possível pendência | Derivada pelo trigger: última mensagem é do aluno = está esperando |
| Busca por nome, telefone, CPF, matrícula | `whatsapp_conversas_listar` (CPF/matrícula quando há aluno vinculado) |
| Resiliência | Ver seção 5 |
| Supervisão | `whatsapp_supervisao` (gestão) |

---

## 3.1 Nova conversa — quando somos nós que escrevemos primeiro

Até a primeira versão, a Central só sabia **responder**: toda conversa nascia de
uma mensagem do aluno. Isso empurrava o operador de volta para o celular ou para
o WhatsApp Web sempre que ele precisava iniciar um contato — e o que sai por
fora não tem histórico aqui, não tem responsável e não aparece na supervisão.

Como funciona:

| Passo | O que acontece |
|---|---|
| O operador clica em **Nova conversa** | Só aparece habilitado se houver número conectado |
| Escolhe o número de saída | Só os que estão de pé agora; com um só, não há escolha a fazer |
| Procura o aluno (opcional) | Preenche o telefone da ficha e deixa a conversa já vinculada |
| Digita o número | Enquanto digita, a Central avisa se **já existe** conversa com ele, e de quem é |
| Escreve a primeira mensagem | Sem mensagem não há envio: conversa vazia não existe no WhatsApp |

Três decisões que valem registro:

1. **A conversa nasce no envio, não ao abrir o formulário.** Se nascesse antes,
   todo operador que desistisse no meio deixaria conversa vazia na caixa de
   entrada. E como falha de envio é gravada como mensagem `FALHOU`, a conversa
   nunca fica muda: ou tem a mensagem, ou tem o registro do erro.

2. **"Nova conversa" não fura a trava de responsável.** Se já existe conversa
   com aquele número e ela é de outro operador, o backend recusa dizendo o nome
   de quem está atendendo. Sem isso, o recurso viraria a porta dos fundos para
   dois operadores falarem com o mesmo aluno.

3. **Conversa que nós iniciamos não entra em "Sem retorno".** Ninguém está
   esperando resposta nossa ainda. Como o filtro padrão da tela é justamente
   "Sem retorno", a conversa recém-criada ficaria invisível no instante em que
   mais importa — por isso a tela troca o filtro para "Minhas" e abre a conversa.

O número de saída continua sendo decidido no **banco**: a tela manda o canal,
nunca a sessão.

## 3.2 O que a gestão faz sem depender de SQL

| Ação | Onde |
|---|---|
| Cadastrar, renomear ou desativar um número | botão **Números** |
| Ver o QR Code | faixa de status, quando o número está aguardando leitura |
| Reconectar | faixa de status |
| Desconectar | faixa de status, só quando o número está no ar |
| Desvincular o aparelho (`logout`) | faixa de status, **em dois cliques** |
| Supervisão por operador | botão **Supervisão** |

`sessao_chave` **não pode ser editada depois de criada**: é ela que amarra a
conversa ao canal, e trocá-la orfanaria o histórico. No cadastro ela é
normalizada para minúsculas — divergir do serviço por causa de um espaço ou uma
maiúscula é uma falha que não avisa: o número simplesmente nunca conecta.

Desvincular exige confirmação porque obriga a reparear, e **o histórico do
aparelho só é importado no pareamento**.

## 4. Decisões que valem registro

**A armadilha do nono dígito.** A base tem telefone com e sem o 9; o WhatsApp
manda em formatos variados. A primeira versão da chave de comparação usava "DDD
+ últimos 8 dígitos" — e **foi reprovada no teste contra o banco**: o fixo
`3333-4444` e o celular `9 3333-4444` caíam na mesma chave. A versão final
canoniza pelo terceiro dígito: 10 dígitos começando em 6-9 é celular antigo e
ganha o 9; começando em 2-5 é **fixo e nunca ganha**. Testado com as quatro
formas do mesmo celular colapsando numa chave só.

**Histórico importado não conta como "não lida".** Sem isso o primeiro
pareamento marcaria milhares de conversas como não lidas e o contador nasceria
mentindo. Para o histórico o sinal certo é "sem retorno".

**Lotes fora de ordem não bagunçam a fila.** Na importação as mensagens chegam
em qualquer ordem. O trigger compara com a mensagem mais recente da conversa:
uma mensagem antiga não ressuscita a fila nem reescreve a prévia — mas pode
antecipar o **início** da espera, que é o número honesto.

**Credencial não fica em arquivo solto.** `useMultiFileAuthState` é exemplo de
documentação. Aqui o disco do container é a cópia quente e o Postgres a cópia
fria, gravando **sempre no disco primeiro** — assim o disco nunca está mais
velho que o banco, e o serviço não sobe com credencial vencida.

**A VPS não tem credencial de banco.** Ela fala com a Edge Function assinando
com HMAC. Invadir a máquina não vira invadir o CRM, e não há histórico de aluno
guardado nela.

**Baileys fixado em 6.7.24, sem `^`.** O `latest` do npm aponta para um release
candidate (`7.0.0-rc14`), e existe uma `6.17.16` publicada fora de ordem em
março/2025 — `^6.7.24` resolveria justamente para ela.

---

## 4.1 Vigia das sessões (quem avisa que caiu)

O gateway bate o coração a cada 30s gravando `ultimo_heartbeat_em`. Um cron roda
`whatsapp_monitorar_sessoes()` **a cada 5 minutos**: se o sinal de um número
parar por mais do que `whatsapp_config.minutos_sem_heartbeat_alerta` (padrão 5),
a gestão recebe notificação no sino dizendo **qual número** caiu e **há quanto
tempo**, com link para a Central. Enquanto continuar fora, **um aviso por hora**.
Quando volta, chega o aviso de recuperação com o tempo total que ficou fora, e
fica registrado em `whatsapp_conexao_eventos`.

São **três motivos**, com mensagens diferentes porque a ação da gestão é
diferente em cada um:

| Motivo | O que aconteceu | O que fazer |
|---|---|---|
| `SEM_HEARTBEAT` | O serviço na VPS parou de responder | Mexer no servidor |
| `PAREAMENTO_NECESSARIO` | Serviço no ar, sessão caiu (`PAREAMENTO_NECESSARIO` ou `AGUARDANDO_QR`) | Ler o QR na Central |
| `ERRO` | Serviço no ar, sessão em erro | Ler o detalhe na notificação |

Detalhes que importam:

- Canal que **nunca conectou** não gera alerta — ele não caiu, ainda não subiu.
  Cobre o setup: cadastrar o número e ficar em `DESCONECTADO` ou `AGUARDANDO_QR`
  antes do primeiro pareamento é o fluxo normal.
- `SEM_HEARTBEAT` tem **precedência**: se o serviço parou, o `conexao_status`
  gravado é informação velha — foi o próprio serviço morto que escreveu.
- **`AGUARDANDO_QR` entra junto com `PAREAMENTO_NECESSARIO`**, e isso é
  proposital: no gateway o estado `PAREAMENTO_NECESSARIO` dura cerca de **cinco
  segundos** — logo depois o serviço já pede QR novo e fica parado em
  `AGUARDANDO_QR` até alguém escanear. Alertar só no primeiro seria um alarme
  que nunca toca.
- `DESCONECTADO` sozinho **não** alerta: com o serviço vivo é estado transitório
  de reconexão; com o serviço morto quem acusa é o heartbeat.
- **Voltar** exige heartbeat em dia **e** `CONECTADO`. `AGUARDANDO_QR` não é
  recuperação — é o próprio problema; `CONECTANDO` também não.
- Se o motivo mudar no meio da queda (pedia QR e depois o servidor morreu), o
  diário registra a mudança, mas **não** sai notificação nova: a trava de uma
  hora continua valendo, e o próximo aviso já sai com o motivo atualizado.

## 5. Resiliência

| Situação | O que acontece |
|---|---|
| Internet cai | Reconexão com espera crescente, 2s → 5min |
| Supabase fora do ar | Mensagens ficam em fila no disco e são entregues depois, na ordem |
| Container reiniciado | Credencial vem do volume; volta sem QR |
| VPS nova / volume perdido | Credencial restaurada do Postgres |
| Sessão derrubada no celular | `PAREAMENTO_NECESSARIO` + QR novo na Central |
| Outro aparelho assume | `ERRO`, e **não** reconecta sozinho (evita cabo de guerra) |
| Processo travado sem morrer | Batimento para, a Central mostra fora do ar, e o vigia reinicia em 10 min |
| Envio falha | Vira mensagem `FALHOU` e a conversa **continua** na fila de sem retorno |

Queda **nunca** apaga mensagem já gravada: o histórico vive no Supabase.

---

## 6. Implantação — na ordem

1. **VPS + Docker.** Ver `services/whatsapp-gateway/README.md`.
2. **Segredos.** `openssl rand -hex 32` duas vezes; mesmos valores no `.env` da
   VPS e nos secrets do Supabase (`WHATSAPP_GATEWAY_SEGREDO`,
   `WHATSAPP_GATEWAY_TOKEN`, `WHATSAPP_GATEWAY_URL`).
3. **Migrations, nesta ordem.** Ambas validadas em staging
   (`edlzlfbstshojxrudwaa`); **nenhuma aplicada em produção**:
   - `20260817120000_central_whatsapp.sql` — a Central
   - `20260818130000_whatsapp_monitor_sessao.sql` — o vigia das sessões
   - `20260818140000_whatsapp_alerta_indisponibilidade.sql` — os três motivos de alerta
4. **Edge Functions** (o `config.toml` do repo aponta para staging — passe o ref):

```bash
supabase functions deploy whatsapp-webhook --project-ref ahattpqrjmhkzsmnbdzs --no-verify-jwt
supabase functions deploy whatsapp-send    --project-ref ahattpqrjmhkzsmnbdzs
supabase functions deploy whatsapp-sessao  --project-ref ahattpqrjmhkzsmnbdzs
```

5. **Cadastrar os canais** na Central (gestão), com `sessao_chave` idêntica à do
   `SESSOES` no `.env`.
6. **Subir o serviço** e confirmar `AGUARDANDO_QR` nos logs.
7. **Desconectar as outras sessões de WhatsApp Web no celular.**
8. **Ler o QR** pela Central. Acompanhar o painel de sincronização.
9. Só depois do primeiro número estável, ligar o segundo.

O `whatsapp-webhook` vai com `--no-verify-jwt` (o gateway não tem JWT de
usuário); a assinatura HMAC faz o papel da autenticação.
