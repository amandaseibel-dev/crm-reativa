# Ações Massivas — auditoria das datas de acionamento e da cobertura

**Data:** 2026-10-15 · **Escopo:** SÓ LEITURA. Nada foi alterado em produção, nem
no banco nem no front.
**Fonte:** produção (`ahattpqrjmhkzsmnbdzs`), lida pelo SQL Editor — o conector
Supabase desta sessão perdeu o acesso ao projeto (só enxerga `biblioteca` e
`Base reativa`).
**Filtro usado em toda medição do universo**, salvo nota em contrário:
`{"operador":"todos","canal":"WHATSAPP","tipo_cobranca":"MENSALIDADES_E_ACORDOS","recencia_dias":10}`.
Declarar o filtro é obrigatório: `operador` ausente vale `livres`, não `todos`.

---

## 1. Fotografia do universo

| motivo | alunos | valor |
|---|---:|---:|
| **retorno_futuro** | **7.080** | **R$ 14.134.518** |
| DISPONÍVEL | 3.295 | R$ 7.009.578 |
| acao_massiva_recente | 2.238 | R$ 1.984.181 |
| encerrado_operacional | 420 | R$ 133.489 |
| contato_indisponivel | 350 | R$ 422.239 |
| liquidado_prime | 248 | R$ 546.066 |
| confirmacao_pendente | 190 | R$ 1.248.810 |
| fora_tipo_cobranca | 126 | R$ 436.029 |
| **universo** | **13.947** | — |

Metade do universo (50,8%) está parada em "Retorno agendado para data futura".

---

## 2. ACHADO PRINCIPAL — o retorno que bloqueia é automático, não é agendamento

### 2.1 Quem agendou

| origem do retorno | alunos | valor | com retorno em até 2 dias | retorno mais distante |
|---|---:|---:|---:|---|
| **AUTOMATICO** | **6.829 (96,5%)** | R$ 13.168.152 | 5.790 | 2026-12-02 |
| OPERADOR | 246 (3,5%) | R$ 966.366 | 179 | 2026-10-24 |
| (nulo) | 5 | R$ 0 | 4 | 2026-10-20 |

Casa com a medição de 15/10 do painel "Meu dia": `alunos.data_retorno` tem
13.293 linhas e só 3,2% com origem `OPERADOR`.

### 2.2 De onde vem

Dos 5.790 com retorno marcado para amanhã (16/10), **5.466 têm
`status_acionamento = 'Ação massiva externa enviada — aguardando retorno'` e
todos vieram da mesma campanha: 2026-10-06** (4.610 WhatsApp em 3 lotes +
4.736 e-mail em 3 lotes, dos quais 724 sem `lote_id`).

A cadeia é:

1. a campanha avança `alunos.data_ultimo_acionamento` (regra de 02/10);
2. o `status_acionamento` da massiva é **pegajoso** — hoje **6.345 alunos** o
   carregam, e ele só sai com uma tabulação real do operador;
3. `recalcular_situacao_aluno`, no ramo COBRANÇA_VENCIDA, faz
   `if status_acionamento ilike 'Ação massiva%' and (hoje - ult_acion) < 10
   then data_retorno := ult_acion + 10` (regra de 04/08/2026);
4. a recalculadora é chamada por dezenas de fluxos. Cada chamada re-empurra o
   +10. O gatilho de acionamento foi isentado em 04/10
   (`20261004103024 acao_massiva_sem_retorno_automatico`, **confirmado em prod**),
   mas os outros chamadores não.

Resultado: **5.604 dos 6.345 alunos com o status pegajoso estão hoje com
retorno futuro.**

### 2.3 Quanto isso custa

**3.273 alunos / R$ 9.398.511 estão travados SÓ pelo retorno automático** —
têm telefone e já passaram da recência de 10 dias do canal. A fila disponível
de hoje (3.295) praticamente **dobraria**.

### 2.4 Por que isso descalibra a tela

- **A recência é por canal; o retorno não.** Uma campanha de WhatsApp bloqueia
  o mesmo aluno para e-mail durante 10 dias, embora o filtro de recência tenha
  sido feito justamente por canal.
- **Precedência engana.** `retorno_futuro` vem antes de `acao_massiva_recente`
  na lista de motivos, então a tela diz "Retorno agendado para data futura"
  quando a razão real é "recebeu a massiva há X dias". É exatamente a sensação
  de "o aluno sumiu".
- **Dois cooldowns de 10 dias** fazem o mesmo trabalho: `recencia_dias` (filtro
  da ação, por canal, ajustável na tela) e o retorno +10 (invisível, global,
  fora do controle da tela).

---

## 3. Dois caminhos de e-mail ainda escrevem retorno por fora do banco

A correção de 04/10 fechou o gatilho do banco, mas o front continua gravando
direto na tabela:

- [`src/pages/EnvioGmailLote.jsx:105`](../src/pages/EnvioGmailLote.jsx#L105) —
  grava `data_retorno`, `status_acionamento` ("Ação massiva externa enviada —
  aguardando retorno"), `status_jornada = RETORNAR_DEPOIS`, `status_atual`,
  `proxima_acao` e `data_ultimo_acionamento`. São as 724 movimentações sem
  `lote_id` de 06/10.
- [`src/components/EmailAlunoUnificado.jsx:161`](../src/components/EmailAlunoUnificado.jsx#L161)
  — grava `status_acionamento = 'E-mail enviado - …'` e `data_retorno` do
  desfecho. Hoje bloqueiam 168 + 59 + 42 alunos (avisos de mensalidade, novas
  condições, acordo quebrado).

Além disso, `proximoDiaUtil(10)` conta **10 dias ÚTEIS** (≈14 corridos),
enquanto a recência conta 10 corridos: o retorno sobrevive à janela da ação em
~4 dias. A função ainda usa `toISOString()` sobre um `Date` local, o que desloca
a data em um dia para envios depois das 21h.

---

## 4. Quem fica fora do universo (não aparece nem como indisponível)

Títulos não quitados, com valor > 0, cujo dono não entra em `acoes_massivas_universo`:

| situação do título | tipo | alunos fora | valor |
|---|---|---:|---:|
| CANCELADA | mensalidade | 94 | R$ 2.804.154 |
| EM_CONFIRMACAO | mensalidade | 227 | R$ 359.244 |
| DEVOLVIDO | mensalidade | 7 | R$ 42.490 |
| NEGOCIADO | `tipo_boleto = 'Acordo'` | 22 | R$ 15.825 |
| DUPLICADA | mensalidade / acordo | 5 | R$ 3.399 |
| ABERTO | `tipo_boleto = 'Acordo'` | 1 | R$ 304 |

A base está correta onde importa: **0 alunos fora** em ABERTO e NEGOCIADO de
mensalidade (21.076 + 11.153 + 3.415 + 4.199 + 2.251 + … títulos) e **nenhum
caso de vencimento nulo**.

Pelo lado operacional o buraco é pequeno: **27 casos ativos com
`total_em_aberto > 0` (R$ 71.491)** não aparecem em lugar nenhum da tela.

Os dois grupos que merecem decisão:

- **EM_CONFIRMACAO (227 alunos / R$ 359 mil):** somem em silêncio. O motivo
  `confirmacao_pendente` (190 alunos) vem de outra fonte
  (`solicitacoes_confirmacao_pagamento` + `situacao_operacional`) e não os pega.
  O certo seria aparecerem **com motivo**, não desaparecerem.
- **CANCELADA (94 alunos / R$ 2,80 mi):** exclusão provavelmente correta para
  cobrança, mas o valor segue contando em outros indicadores de saldo.

---

## 5. As datas que estão certas

- `v_hoje`, `v_hoje_ini` e `v_mes_ini` do universo: todos em
  `America/Sao_Paulo`. "Hoje" e "no mês" estão corretos.
- Recência da massiva: `v_hoje < (ult_mass at time zone 'America/Sao_Paulo')::date + v_rec`
  — conversão de fuso correta, bloqueio de D a D+9, livre em D+10.
- `dias_minimo_sem_contato`: `(ultimo_acionamento at time zone 'America/Sao_Paulo')::date <= hoje - N`
  — correto (inclusivo: "acima de 7 dias" libera exatamente no 7º).
- Cobertura (`acionado_mes` / `acionado_hoje` / `nunca_acionado`): comparação de
  `timestamptz` contra os marcos em BRT, correta; finalização desfeita não conta.

---

## 6. Defeitos reais de data, porém pequenos hoje

### 6.1 `casos.data_ultimo_acionamento = registrado_em::date` sem fuso

O gatilho `fn_atualizar_ultimo_acionamento` (em prod, com a guarda da massiva
ativa) grava `new.registrado_em::date`. O banco está em **UTC**, então ação
entre 21h e 00h BRT é datada no dia seguinte. A mesma função converte
corretamente em outros pontos — é inconsistência interna.

**Medido:** 3 movimentações em 85.621 nos últimos 180 dias. 155 casos com data
divergente de `alunos.data_ultimo_acionamento`, 65 adiantadas. Corrigir é
barato, mas não é isso que esconde aluno.

### 6.2 Duas listas de "tipo de acionamento"

`eh_tipo_acionamento` (12 tipos, com 5 administrativos: `QUITADO_MANUAL`,
`TERMO_ENVIADO_ADM`, `RETORNO_ADM_CRIADO`, `RETORNO_ADM_CONCLUIDO`,
`COMPROVANTE_ENVIADO_BAIXA`) alimenta `alunos.data_ultimo_acionamento` e a
fidelização. `acoes_massivas_tipo_cobertura` (7 tipos) alimenta a cobertura.

**Medido (30 dias):** 13.670 alunos acionados, 52 só com evento administrativo,
90 com o último evento administrativo, **1** protegido pela fidelização por
evento administrativo.

Efeito colateral a observar: `acoes_massivas_concluir_lote` descarta quem tem
`data_ultimo_acionamento > exportado_em`. Um evento administrativo entre
exportar e confirmar tira o aluno do lote mesmo ele tendo recebido a mensagem.

---

## 7. APLICADO em 15/10 — item 1 da lista abaixo

`20261015124500_retorno_futuro_so_bloqueia_agendamento_do_operador`, dois
patches ancorados em `acoes_massivas_universo`. **Em produção**, registrada em
`supabase_migrations.schema_migrations` (é a versão mais recente do banco).

| prova | antes | depois |
|---|---|---|
| md5 de `pg_get_functiondef` | `cb618e31cf9d821a5f53692b978911d0` | `9878ffd8b7dc404dcdf34d506d9c32e9` |
| ACL | `postgres=X ; authenticated=X ; service_role=X` | idêntica |

Universo medido depois de aplicar (mesmo filtro, 13.947 alunos nos dois lados):

| motivo | antes | depois |
|---|---:|---:|
| **DISPONÍVEL** | 3.289 / R$ 6.971.172 | **6.366 / R$ 15.559.699** |
| **retorno_futuro** | 7.091 / R$ 14.178.391 | **255 / R$ 982.024** |
| acao_massiva_recente | 2.236 / R$ 1.980.190 | 5.954 / R$ 6.534.345 |
| contato_indisponivel | 349 | 390 |
| encerrado_operacional | 419 | 419 |
| liquidado_prime | 248 | 248 |
| confirmacao_pendente | 190 | 190 |
| fora_tipo_cobranca | 125 | 125 |

Bate com a simulação revertida (6.369 / 251) dentro do que a base se move
durante o dia. Os quatro motivos sem relação com retorno ficaram idênticos.

**Caminho da tela conferido** (`acoes_massivas_previa`, WhatsApp, todos,
MENSALIDADES): universo 13.947, **disponíveis 5.084**, retorno_futuro 108,
seleção de 10 devolvida normalmente. Atenção ao ler a tela hoje: com o filtro
"Não acionados no mês" sobram só 21 elegíveis, porque a campanha de 06/10 tocou
quase todo mundo — o ganho aparece em "Todos", governado pela recência.

Rollback pronto em
`supabase/rollbacks/20261015124500_…rollback.sql` (reverte a regra; a coluna
`retorno_origem` acrescentada à CTE `pop` fica e é inerte).

## 8. O que ainda falta decidir

1. ~~`retorno_futuro` só bloquear retorno de operador~~ — **feito, seção 7.**
2. **Fechar os dois caminhos de e-mail do front** para que nenhuma campanha
   crie retorno, status de jornada ou tabulação (hoje só o banco respeita a
   regra de 03–04/10).
3. **Fazer EM_CONFIRMACAO aparecer com motivo** em vez de sumir do universo.
4. Corrigir o `::date` do gatilho e alinhar `proximoDiaUtil` com a janela de
   dias corridos — ambos pequenos, mas são dívida de data.

Os itens 2 a 4 **não** foram aplicados. Qualquer mexida na camada Prime
(`liquidado_prime`) passa antes por `docs/integracoes/README.md`.

> Enquanto o item 2 não for feito, uma campanha disparada pelo
> `EnvioGmailLote` continua gravando `data_retorno` e
> `status_jornada = RETORNAR_DEPOIS` direto na ficha, e segue poluindo a agenda
> do operador e a jornada do aluno. Para as Ações Massivas o efeito agora
> depende da origem: esse fluxo **não reescreve `retorno_origem`**, então o
> aluno só volta a ser escondido se a origem que já estava na ficha for
> `OPERADOR` — caso em que a campanha empurra para a frente um retorno que o
> operador tinha marcado. Mais um motivo para fechar o item 2.
