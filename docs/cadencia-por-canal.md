# Cadência por canal — desenho

Estado: **desenho aprovado para revisão**. Nada aplicado, nem em produção nem
em staging. Premissa definida pela Amanda em 20/08/2026.

## O que a premissa pede

| | Canal 1 | Canal 2 |
|---|---|---|
| modo | `ATIVO_CONTROLADO` | `SOMENTE_RESPOSTAS` |
| novas abordagens / operador / dia | 10 | 0 |
| novas abordagens / canal / dia | 100 | 0 |
| janela | 09:00–20:00 | — |
| respostas | não consomem cota | liberadas, sem cota |
| recontato automático | não | não |

Modos configuráveis: `ATIVO_CONTROLADO`, `SOMENTE_RESPOSTAS`, `PAUSADO`.
Controle central no backend, valendo para todos os operadores ao mesmo tempo.
Os dois limites do canal 1 valem **simultaneamente** (E, não OU).

## Onde a trava entra — e por que o gateway fica protegido de graça

Todo envio do CRM segue um caminho só:

```
frontend  →  Edge Function whatsapp-send
                  │
                  ├─ RPC whatsapp_preparar_envio        (responder)
                  └─ RPC whatsapp_preparar_envio_novo   (iniciar)
                  │
                  │   if (erroPreparo) return 403;   ← sai ANTES do fetch
                  ▼
              fetch gateway /enviar
```

A Edge Function já devolve 403 e **retorna** quando a RPC levanta exceção — a
linha `if (erroPreparo) return jsonResp(..., 403)` vem antes do `fetch`. Então
travar dentro das duas RPCs satisfaz "nenhuma tentativa bloqueada chega ao
gateway" **sem alterar a Edge Function e sem tocar no gateway**.

Não há terceiro caminho: as duas RPCs acima são as únicas que devolvem
`sessao_chave`, e `sessao_chave` é o único jeito de o gateway saber por qual
número enviar.

Repare também que a Edge só registra mensagem `FALHOU` DEPOIS do fetch. Uma
tentativa bloqueada não vira mensagem falsa na conversa — o que é correto, e
tem um custo discutido em "Decisão 4".

## Modelo de dados

### Configuração — colunas em `whatsapp_canais`

```
modo                        text  not null default 'ATIVO_CONTROLADO'
                            check (modo in ('ATIVO_CONTROLADO','SOMENTE_RESPOSTAS','PAUSADO'))
limite_abordagens_operador  int                     -- null = sem limite
limite_abordagens_canal     int                     -- null = sem limite
janela_inicio               time  default '09:00'
janela_fim                  time  default '20:00'
modo_alterado_em            timestamptz
modo_alterado_por           text
```

Fica no canal, não numa tabela de configuração global, porque a premissa é
**por número**: o canal 1 e o canal 2 têm regimes diferentes ao mesmo tempo.
`modo_alterado_por` existe porque mudar o modo é decisão de gestão com efeito
sobre a operação inteira — precisa de dono e data.

### Contador — tabela `whatsapp_abordagens`

```
canal_id         uuid  not null
conversa_id      uuid  not null
operador_email   text  not null
dia              date  not null
criado_em        timestamptz
unique (canal_id, conversa_id, dia)
```

**Por que uma tabela e não uma contagem sobre `whatsapp_mensagens`:** a
classificação "isto foi uma abordagem" depende do estado da conversa **no
instante do envio**, e esse estado muda depois — o aluno responde amanhã e a
mensagem de hoje passaria a parecer resposta. Contar retroativamente daria
número diferente a cada dia. O registro é feito na hora e não se mexe mais.

**Por que `unique (canal_id, conversa_id, dia)`:** "10 novas abordagens" é 10
**pessoas**, não 10 mensagens. Insistir três vezes no mesmo contato frio no
mesmo dia consome 1 de cota, não 3.

`dia` é calculado em `America/Sao_Paulo`, não em UTC. O banco roda em UTC, e
`now()::date` viraria o dia às 21:00 de Brasília — a cota do operador
reiniciaria no meio do expediente e a janela de 20:00 fecharia na hora errada.

## A regra que separa abordagem de resposta

No momento do envio, a conversa é consultada:

- **tem pelo menos uma mensagem de ENTRADA** → é **resposta**. Não consome
  cota, não olha janela, não olha limite.
- **não tem nenhuma ENTRADA** → é **abordagem**. Passa por modo, janela e os
  dois limites.

Conversa nova (`preparar_envio_novo`) nunca tem ENTRADA: é sempre abordagem.
Se a trava barrar, a conversa recém-criada é desfeita junto — a RPC cria a
conversa e levanta a exceção na mesma transação, então não sobra conversa
vazia na caixa de entrada.

Isto também implementa "sem recontato automático" por construção: insistir num
contato que nunca respondeu continua sendo abordagem todo dia, e continua
consumindo cota todo dia.

## Comportamento dos três modos

| | abordagem | resposta |
|---|---|---|
| `ATIVO_CONTROLADO` | sujeita a janela + 2 limites | livre |
| `SOMENTE_RESPOSTAS` | **bloqueada sempre** | livre |
| `PAUSADO` | bloqueada | **bloqueada** |

`PAUSADO` bloqueia inclusive resposta, de propósito: é a chave geral para
quando o número está em risco e nada pode sair por ele. Se bloqueasse só
abordagem, seria igual a `SOMENTE_RESPOSTAS` e não serviria para nada.

## Os dois limites do canal 1

Avaliados na mesma transação, com `SELECT ... FROM whatsapp_canais WHERE id = ?
FOR UPDATE` antes de contar. Sem esse lock, dois operadores enviando ao mesmo
tempo contam 99 cada um, os dois passam, e o canal fecha o dia em 101. Com
100 envios por dia a disputa pelo lock é irrelevante.

Mensagens distintas, porque a ação do operador é diferente em cada caso:

- operador no teto → *"você já iniciou 10 conversas novas hoje neste número.
  Responder quem te procurou continua liberado."*
- canal no teto → *"este número já iniciou 100 conversas novas hoje. Nenhum
  operador inicia novas até amanhã."*
- fora da janela → *"novas conversas só entre 09:00 e 20:00."*
- `SOMENTE_RESPOSTAS` → *"este número está em modo somente respostas: só dá
  para responder quem procurou a empresa."*
- `PAUSADO` → *"este número está pausado: nenhuma mensagem sai por ele."*

## Frontend

O backend é a autoridade; a tela só evita que o operador escreva para levar
"não" depois:

- **Nova conversa** desabilitado quando o canal está em `SOMENTE_RESPOSTAS` ou
  `PAUSADO`, com o motivo no lugar do botão;
- contador **"restam N de 10 hoje"** ao lado do seletor de canal;
- aviso quando o canal chega ao teto, para o operador não achar que é bug dele.

## Decisões que dependem da Amanda

### 1. Ações Massivas não passa por aqui — e é a maior brecha

`registrar_acao_massiva` com `p_canal = 'WHATSAPP'` **não envia nada**: gera uma
planilha XLSX com nome e telefone, e o disparo acontece fora do sistema. Não
passa pela Edge, não passa pelo gateway, e a tabela nem tem `canal_id`.

Consequência: "bloquear ações massivas por esse canal" não é implementável como
está — elas nunca estiveram ligadas a um canal. E, pior, o volume disparado por
essa via **não entra no teto de 100**. Um lote de 500 sai por fora e o contador
do canal continua marcando zero.

Três saídas possíveis:
- **(a)** amarrar Ações Massivas a um `canal_id` e fazê-la consumir a mesma cota
  — o teto passa a valer para a empresa inteira, e não só para a Central;
- **(b)** bloquear o canal `WHATSAPP` de Ações Massivas enquanto durar esta
  fase, deixando o disparo ativo só pela Central;
- **(c)** deixar como está e assumir que o teto de 100 cobre só a Central.

Recomendo **(b)** agora e **(a)** depois: (b) é uma linha e fecha a brecha hoje;
(a) é o desenho certo, mas mexe numa tela que não está no escopo desta rodada.

### 2. Conversa dormente ainda conta como resposta

Pela regra "tem ENTRADA → resposta", um aluno que escreveu **uma vez, há oito
meses**, deixa a conversa liberada para sempre. Abordagem fria vestida de
resposta, sem consumir cota.

Você escreveu "permitir resposta quando o aluno tiver iniciado/respondido a
conversa", sem prazo — implementei exatamente isso e não inventei janela. Mas a
brecha é real. A correção seria exigir ENTRADA nos últimos N dias (30 é o valor
que eu sugeriria); fora disso, volta a ser abordagem.

### 3. `PAUSADO` bloqueando resposta

Assumi que sim, pelo argumento acima. Se a intenção for "pausar só a
iniciativa", `PAUSADO` vira sinônimo de `SOMENTE_RESPOSTAS` e sobra um modo.
Confirme.

### 4. Tentativa bloqueada não fica registrada

A trava levanta exceção, e exceção desfaz a transação — inclusive qualquer
registro que ela tivesse gravado. Então hoje dá para medir **quantas abordagens
saíram**, mas não **quantas foram barradas**.

Para "a evolução será decidida com base nos indicadores reais", saber quantas
vezes a equipe bateu no teto é justamente o indicador que diz se 10 e 100 estão
apertados ou folgados. Registrar isso exige uma alteração pequena na Edge
Function: ao receber 403, chamar uma RPC de log antes de devolver o erro. É a
única alteração fora do banco em todo o desenho, e fica para uma segunda etapa
se você quiser.

---

# Backlog — melhorias não bloqueadoras

Encontradas durante a implementação em 20/08/2026. Nenhuma impede o pareamento
do canal 2.

**1. Ações Massivas deveria consumir a mesma cota.** Hoje está bloqueada por
trava de fase. O desenho certo é dar `canal_id` à ação e fazê-la passar por
`whatsapp_cadencia_checar`, para o teto de 100 valer para a empresa e não só
para a Central. Mexe na tela de Ações Massivas, fora do escopo desta rodada.

**2. Deploy da Edge `whatsapp-send`.** O código está no repo com o registro de
bloqueios. Sem o deploy, os bloqueios são aplicados normalmente e apenas não
ficam registrados — os indicadores mostram abordagens que saíram, não tentativas
barradas. Um comando, independente das migrations:
`supabase functions deploy whatsapp-send --project-ref ahattpqrjmhkzsmnbdzs`

**3. Tela de configuração da cadência.** `whatsapp_canal_cadencia_salvar` e
`whatsapp_cadencia_indicadores` existem e estão testadas, mas só são alcançáveis
por SQL. Enquanto não houver tela, mudar limite depende de quem tem acesso ao
banco — o que contraria "subir manualmente depois de observar os indicadores".

**4. Staging não espelha produção.** Faltam `registrar_acao_massiva` (testada
por stub) e a Edge `whatsapp-send`; e sobra uma constraint
`ck_whatsapp_msg_status` da branch pausada de status de entrega, que produção
não tem. Nenhuma afeta o que foi entregue, mas cada divergência é um teste que
não dá para fazer aqui.

**5. Fila e quarentena do gateway ainda são globais.** Item da auditoria do canal
2: o backoff do `outbox` é compartilhado, então falhas de CRM no canal 2
desaceleram a entrega do canal 1. Não mistura dados — cada item carrega
`sessao` —, só divide velocidade.

**6. RLS não isola por operador nem por canal.** Decisão sua de 20/08: não é
bloqueador com equipe única atendendo os dois números. Fica registrado porque
deixa de ser aceitável se as carteiras se separarem.
