# Diagnóstico — os 61 alunos com `data_ultimo_acionamento` atrás da própria movimentação

**Data:** 2026-10-20 · **Escopo:** somente leitura. Nenhuma migration, nenhuma
escrita, nenhum fluxo alterado. **Nada foi corrigido.**

**Fontes.** Consultas **read-only** ao banco de **produção**
(`ahattpqrjmhkzsmnbdzs`), o ledger `supabase_migrations.schema_migrations`
(texto das migrations aplicadas), as duas tabelas de trilha que os reparos
anteriores deixaram em prod, e o código de `origin/main` citado com arquivo e
linha. Toda afirmação numérica deste documento vem de uma consulta executada em
20/10/2026. O que não foi possível reconstruir está marcado como
**NÃO RECONSTRUÍDO** — não foi inferido.

Integração Prime/ULBRA: `docs/integracoes/README.md` consultado conforme
CLAUDE.md. Este diagnóstico **não cria nem altera regra sobre dado do Prime**.

---

## Sumário executivo

1. **Não é um defeito só, são três — e dois deles já estão mortos.** Os 61
   alunos se dividem em três grupos por mecanismo, não por sintoma: **5** são
   ação massiva realmente perdida (grupo A), **51** são a **contradição entre
   dois catálogos de "acionamento" que convivem em produção** (grupo B), e **5**
   são **diferença de relógio de milissegundos** entre o navegador e o servidor
   (grupo C).

2. **A causa que apagava o campo está fechada desde 28/08/2026 e a prova é a
   série temporal.** Casos novos por mês da movimentação: julho 20, agosto 37,
   **setembro 0**, outubro 4 — e os 4 de outubro são **todos** do grupo C
   (sub-segundo). Nenhum caso com atraso real em dias ou campo nulo nasceu depois
   de 27/08/2026.

3. **A causa VIVA é o grupo C, e é inerte.** O frontend escreve
   `alunos.data_ultimo_acionamento` com o relógio do navegador, sem guarda de
   "só para frente", em mais de 20 pontos de `origin/main`. Quando o relógio do
   servidor está alguns milissegundos à frente, o campo nasce atrás da
   movimentação irmã da **mesma ação do operador**. São 0,008 s a 0,167 s de
   atraso. Nenhuma regra do sistema distingue os dois valores.

4. **O grupo B não é bug: é decisão de 28/08 contra a regra do gatilho.** O
   script de reparo `20260828020000_restaurar_acionamento_apagado.sql` deixou
   `QUITADO_MANUAL` de fora **de propósito** ("não são acionamento"), enquanto o
   gatilho que escreve o campo usa `eh_tipo_acionamento`, que **inclui**
   `QUITADO_MANUAL`. Em 56 dos 61 a movimentação mais nova é de um tipo que o
   reparo excluiu. **Corrigir sem decidir o catálogo é escolher um dos dois lados
   por acidente.**

5. **O efeito operacional hoje é quase nulo e está medido, não estimado.** Dos
   61, **58 não são elegíveis para cobrança** (`aluno_elegibilidade_cobranca`),
   **apenas 4 aparecem no universo de ações massivas** e **1 único** está
   `disponivel` — e esse é do grupo C, com 0,14 s de atraso. **Um** aluno é
   rotulado `nunca_acionado` indevidamente, e mesmo ele está barrado por
   `encerrado_operacional`.

6. **A fidelização de 10 dias NÃO é afetada.** Ela lê
   `casos.data_ultimo_acionamento`, e esse campo está **em dia em 60 dos 61**.
   Quem lê o campo do aluno é a família de ações massivas; quem lê o campo do
   caso é fidelização, carteira, fila e saúde da carteira.

7. **O reparo de 1.826 alunos de 28/08 não está no ledger de produção.** A
   tabela `_backup_acionamento_restaurado_20260828` tem as 1.826 linhas
   (`restaurado_em` = 28/08 09:36), o arquivo existe em `origin/main`, e a versão
   `20260828020000` **não** está em `supabase_migrations.schema_migrations`: foi
   rodado à mão. É o que permite medir, mas é dívida de rastreabilidade.

---

## 1. O universo, reproduzido

Regra do universo (a mesma do pedido): aluno cujo
`alunos.data_ultimo_acionamento` é **nulo tendo movimentação de acionamento**, ou
é **menor** que `max(registrado_em)` das movimentações com
`public.eh_tipo_acionamento(tipo)`.

| medida | valor |
| --- | --- |
| total fora de sincronia hoje | **61** |
| campo nulo | 16 |
| campo atrasado | 45 |
| já corrigidos em 20/10 (`_backup_dua_massiva_setembro_20261020`) | 0 — saíram do universo |

Os 72 originais menos os 11 corrigidos pela `20261020093853` fecham em 61
exatamente: a correção de ontem removeu 1 nulo e 10 atrasados, e **nenhum** dos
11 reaparece no universo. O conjunto analisado aqui é o resto completo.

---

## 2. A cadeia de causas, com prova

### 2.1 O ponto de partida: em 16/07 todo mundo estava em dia

A migration `20260716221642_corrigir_ultimo_acionamento_backfill_e_trigger`
criou `eh_tipo_acionamento` com os 11 tipos (o 12º, `ACAO_MASSIVA_EXTERNA_EMAIL`,
entrou em `20260717002553`), criou o gatilho, **e fez backfill usando o catálogo
inteiro**:

```sql
with ac as (select m.aluno_id, max(m.registrado_em) ult
            from public.aluno_movimentacoes m
            where public.eh_tipo_acionamento(m.tipo) group by m.aluno_id)
update public.alunos a set data_ultimo_acionamento = ac.ult
from ac where ac.aluno_id = a.id::text;
```

Logo: **todo caso do universo nasceu depois de 16/07/2026 22:16**. Não há
resíduo de "antes do gatilho existir".

### 2.2 O destruidor: trocar de dono apagava o campo

`internal.set_resp_aluno` (lida em prod hoje) zera o campo quando o e-mail do
responsável muda:

```sql
data_ultimo_acionamento = case when v_ant_email is distinct from v_email
                               then null else data_ultimo_acionamento end,
```

E a mesma função insere a movimentação `REDISTRIBUICAO_SINCRONIZACAO` com
`operador_anterior_email` e `operador_novo_email`. Isso dá **assinatura de
campo**, não timestamp igual: dá para ler na linha se o ramo que zera rodou.

**Resultado da conferência, aluno por aluno:** dos 61, **56 têm uma
`REDISTRIBUICAO_SINCRONIZACAO` posterior à movimentação mais nova com
`operador_anterior_email` ≠ `operador_novo_email`, e em 56 de 56 a primeira
delas é anterior a 28/08/2026.** Zero exceções.

Isso não é descoberta nova: a própria `20260828093507` mediu
"1.619 de 1.619" com a mesma causa e deixou o comentário em
`public._acionamento_nao_volta_para_nulo()`.

Confirmação independente pela outra tabela: o gatilho
`fn_atualizar_ultimo_acionamento` escreve **os dois** campos — `alunos` e
`casos`. Em **60 dos 61**, `casos.data_ultimo_acionamento` está **em dia**
(≥ a data da movimentação, e **igual** à data dela em 49 casos). Ou seja: o
registro chegou, o campo do caso guardou, e **só o campo do aluno foi desfeito**
— `set_resp_aluno` não toca em `casos`.

### 2.3 A torneira fechou em 28/08, e a série temporal prova

`20260828093507` instalou `trg_acionamento_nao_volta_para_nulo`
(BEFORE UPDATE OF `data_ultimo_acionamento`, `status_acionamento`), que devolve o
valor antigo quando o novo é nulo. Como `set_resp_aluno` sempre menciona a
coluna, o gatilho sempre dispara: **o ramo que zerava virou letra morta**.

Casos do universo por mês da movimentação mais nova:

| mês | fora de sincronia | nulos | atraso real (≥ 1 s) | sub-segundo |
| --- | --- | --- | --- | --- |
| 2026-07 | 20 | 10 | 9 | 1 |
| 2026-08 | 37 | 6 | 31 | 0 |
| 2026-09 | **0** | 0 | 0 | 0 |
| 2026-10 | 4 | 0 | **0** | 4 |

A movimentação mais nova de qualquer caso com nulo ou atraso em dias é
**27/08/2026** — um dia antes da trava. Setembro inteiro: nenhum caso.

### 2.4 O reparo que criou o grupo B: dois catálogos de "acionamento"

`20260828020000_restaurar_acionamento_apagado.sql` (em `origin/main`,
**ausente** do ledger de prod, efeito presente: 1.826 linhas em
`_backup_acionamento_restaurado_20260828`, `restaurado_em` = 28/08 09:36)
restaurou assim:

```sql
where m.tipo in ('FINALIZACAO_ATENDIMENTO','ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL')
...
where al.data_ultimo_acionamento is null
```

Três tipos, não doze. E o comentário do próprio script diz que foi deliberado:

> "Tipos como ZERADO_REAL_SEM_SALDO e QUITADO_MANUAL tambem coincidem por data,
> mas nao sao acionamento -- ficaram de fora."

Dois efeitos, os dois medidos:

* quem tinha `FINALIZACAO`/massiva no histórico voltou — **mas para o contato
  anterior**, não para a movimentação mais nova. Dos 31 casos reparados em
  28/08 dentro do universo, em **25** o valor que o campo carrega **hoje** é
  exatamente `acionamento_restaurado` da tabela de trilha, e em **30 de 31** ele
  é `max(registrado_em)` sobre os tipos de contato — nunca sobre o catálogo
  inteiro;
* quem **não** tinha `FINALIZACAO` nem massiva ficou nulo: são os **16** nulos,
  e em **16 de 16** `tem_finalizacao = false`. Não ficaram de fora por descuido;
  ficaram de fora porque não havia o que restaurar pela regra escolhida.

O backfill anterior, `20260821151845_backfill_data_ultimo_acionamento`, usou lista
ainda mais estreita (`FINALIZACAO_ATENDIMENTO`, `FINALIZACAO`) e também só
tocou linhas nulas — é o que explica os 5 do grupo A terem escapado do reparo de
28/08, e isso está provado em 5 de 5: os cinco estão em
`_backup_alunos_dua_20260821` com `dua_antes` **nulo** (a troca de dono tinha
zerado) e `dua_depois` **igual ao valor que o campo carrega hoje** — a data da
`FINALIZACAO`, não a da massiva. Com o campo já preenchido, a cláusula
`where data_ultimo_acionamento is null` de 28/08 não os alcançou.

### 2.5 A causa viva: o relógio do navegador escrevendo sobre o do servidor

Os 5 do grupo C têm a mesma assinatura, em 5 de 5:

| sinal | valor |
| --- | --- |
| atraso | 0,008 s a 0,167 s |
| `id` da movimentação que o campo aponta, menos o `id` da mais nova | **+1** em 5 de 5 |
| mesmo `registrado_por_email` nas duas | 5 de 5 |
| precisão do valor do campo | milissegundo (3 decimais) |
| precisão do `registrado_em` da mais nova | microssegundo (6 decimais) |

Ou seja: **uma única ação do operador** grava duas movimentações consecutivas;
uma carrega o relógio do servidor (`now()`), a outra o do navegador. E o
frontend escreve o campo direto, sem guarda:

* `src/components/LinksPagamentoAluno.jsx:701-702` — `registrado_em: agora` e
  `data_ultimo_acionamento: agora`, o mesmo `agora` do navegador, seguido de
  `registrarHistorico(..., "LINK_ENVIADO_AO_ALUNO", ...)` na linha 718;
* `src/components/FluxoLinksRapido.jsx:318-325`, `src/pages/FilaOperacional.jsx:707-708`,
  `src/components/PainelCarteira.jsx:1785/1912/2046/2179`,
  `src/pages/CRM.jsx:763/829/919`, `src/components/EnvioFinanceiro.jsx:194`,
  `src/components/FinalizacaoTermo.jsx:147`, e mais — **mais de 20 pontos** em
  `origin/main` escrevem o campo com `new Date().toISOString()` ou equivalente.

Nenhum deles compara com o valor que já está lá. O gatilho do banco tem a guarda
("só se o novo for maior"); a escrita do frontend **não tem**.

Tamanho da superfície: dos 18.053 alunos com o campo preenchido, **5.345
carregam valor com precisão de milissegundo** — marca de escrita pelo navegador
— sendo **4.062 de 13.619** só em outubro. A corrida existe em milhares de
gravações por mês e produziu **4 resíduos em outubro** (≈ 0,1%). *(A precisão de
milissegundo é indício forte, não certeza: `now()` cai em milissegundo exato por
acaso em ~1 de 1.000 casos, o que daria ~18 linhas, não 5.345.)*

**NÃO RECONSTRUÍDO:** a ordem exata das duas gravações dentro da ação. O
`trg_aluno_estado_anterior` só registra quando `status_atual` muda, e não houve
linha em `alunos_estado_anterior` nem em `audit_log` para essas 5 escritas do
campo. O que está provado é a coautoria (mesma ação, mesmo operador, `id`
adjacente) e a ausência de guarda na escrita do frontend.

---

## 3. Os três grupos

| grupo | n | o que é | movimentação mais nova | janela | `saldo_total` somado |
| --- | --- | --- | --- | --- | --- |
| **A — massiva realmente perdida** | 5 | campo atrás de uma **ação massiva**, que é acionamento pelos **dois** catálogos | `ACAO_MASSIVA_EXTERNA` | 05/08 a 18/08 | R$ 34.771,80 |
| **B — contradição de catálogo** | 51 | campo atrás de tipo que o reparo de 28/08 excluiu de propósito | `QUITADO_MANUAL` 40, `COMPROVANTE_ENVIADO_BAIXA` 10, `LINK_ENVIADO_AO_ALUNO` 1 | 06/07 a 27/08 | R$ 1.172,40 |
| **C — relógio** | 5 | atraso sub-segundo da mesma ação do operador | `RETORNO_ADM_CONCLUIDO` 3, `QUITADO_MANUAL` 2 | 21/07 a 15/10 | R$ 3.285,33 |

Dentro de B: 16 com campo **nulo** (todos sem `FINALIZACAO` no histórico, 15
deles com `QUITADO_MANUAL` como mais nova) e 35 com campo atrasado de 0 a 48
dias.

### 3.1 Grupo A — as 5 massivas (detalhe completo)

| aluno_id | massiva em | campo em | atraso | `status_jornada` | `casos.dua` |
| --- | --- | --- | --- | --- | --- |
| `bf9e2a20-d83c-4ba1-b138-4f39fc66700d` | 05/08 13:58 | 02/07 11:44 | 34 d | SUSPENSAO_COBRANCA | 05/08 |
| `e00d594f-4b16-4cc0-a2b4-8f645acb8255` | 18/08 15:10 | 22/07 09:38 | 27 d | SUSPENSAO_COBRANCA | 18/08 |
| `1825f037-80a2-45a1-b999-1590c8203043` | 18/08 15:10 | 05/08 14:42 | 13 d | QUITADO | 18/08 |
| `607d43b3-ea02-499b-80c0-0686d62785ba` | 18/08 15:10 | 21/07 18:26 | 28 d | QUITADO | 18/08 |
| `5d0cd260-617b-48f8-b49f-6736d5a35605` | 18/08 15:15 | 22/07 16:26 | 27 d | QUITADO | 18/08 |

Em 5 de 5, `casos.data_ultimo_acionamento` é **exatamente** o dia da massiva: a
massiva foi registrada e o caso guardou. Só o campo do aluno ficou atrás.

Estes 5 são o **mesmo caso dos 11 corrigidos em 20/10**: nos 11,
`_backup_dua_massiva_setembro_20261020` mostra que em 11 de 11 a movimentação
usada era `ACAO_MASSIVA_EXTERNA`. A diferença é só a janela (agosto, não
setembro) e o motivo do escape (o backfill de 21/08 já tinha preenchido o campo,
então o reparo de 28/08 pulou a linha).

### 3.2 Grupo C — as 5 do relógio (detalhe completo)

| aluno_id | mais nova | tipo | campo em | atraso | tipo apontado pelo campo |
| --- | --- | --- | --- | --- | --- |
| `3a4243ab-690f-44bf-a78d-176b99145f25` | 21/07 13:36:54,206376 | RETORNO_ADM_CONCLUIDO | 13:36:54,062 | 0,144 s | LINK_ENVIADO_AO_ALUNO |
| `7c8628ae-f60f-4598-8deb-c91e1d7343d7` | 07/10 12:36:21,625035 | QUITADO_MANUAL | 12:36:21,617 | 0,008 s | QUITADO_MANUAL |
| `452f714e-de62-4703-a835-7655e7005741` | 07/10 12:42:01,000271 | QUITADO_MANUAL | 12:42:00,977 | 0,023 s | QUITADO_MANUAL |
| `d09acf2a-d180-4fc6-bc76-c151d5c982fe` | 08/10 17:43:37,576709 | RETORNO_ADM_CONCLUIDO | 17:43:37,433 | 0,144 s | LINK_ENVIADO_AO_ALUNO |
| `ec324e37-b489-40f2-8b87-fb45a93cb849` | 15/10 11:29:31,998718 | RETORNO_ADM_CONCLUIDO | 11:29:31,832 | 0,167 s | LINK_ENVIADO_AO_ALUNO |

---

## 4. Efeito operacional, medido

### 4.1 Quem lê o campo do **aluno** e quem lê o do **caso**

Levantamento sobre todas as funções, views e matviews de `public`/`internal` que
mencionam `data_ultimo_acionamento`:

| lê `alunos.data_ultimo_acionamento` | lê `casos.data_ultimo_acionamento` |
| --- | --- |
| `acoes_massivas_universo` (campos `nunca_acionado`, `fidelizacao_ativa`, `ultimo_acionamento`) | `caso_dentro_prazo_fidelizacao` (parâmetro vem do caso) |
| `buscar_candidatos_acoes_massivas` (`p_apenas_nunca_acionado AND dua IS NULL`) | `casos_elegiveis_liberacao_fidelizacao`, `liberar_fidelizacao_caso` |
| `total_elegiveis_acoes_massivas` (contador `sem_acionamento`) | `casos_risco_perder`, `fila_casos_sem_responsavel`, `fila_fora_da_cobranca` |
| `acoes_massivas_concluir_lote`, `acoes_massivas_penetracao_por_ano`, `acoes_massivas_penetracao_ano_detalhe` | `carteira_geral_base`, `carteira_acordos_detalhe`, `vw_saude_carteira` |

Consequência direta: **fidelização de 10 dias, carteira, filas e saúde da
carteira não são afetadas** — elas leem o campo do caso, que está em dia em 60
dos 61. O campo do aluno só alcança a família de **ações massivas** (fila,
cobertura e penetração).

### 4.2 O que acontece hoje, aluno por aluno

`public.aluno_elegibilidade_cobranca` rodada para os 61:

| grupo | n | elegível para cobrança | motivo principal de quem não é |
| --- | --- | --- | --- |
| A | 5 | **0** | SALDO_ZERO_DEFINITIVO, SUSPENSAO_COBRANCA |
| B | 51 | **1** | SALDO_ZERO_DEFINITIVO |
| C | 5 | **2** | SALDO_ZERO_DEFINITIVO |

E `public.acoes_massivas_universo` (WhatsApp e e-mail, filtro aberto):

| grupo | n | aparece no universo | `disponivel` | marcado `nunca_acionado` |
| --- | --- | --- | --- | --- |
| A | 5 | 1 | **0** | 0 |
| B | 51 | 1 | **0** | **1** |
| C | 5 | 2 | **1** | 0 |

As 4 linhas que aparecem no universo, abertas:

| aluno_id | grupo | `disponivel` | `motivo` | `nunca_acionado` | efeito real |
| --- | --- | --- | --- | --- | --- |
| `26285c39-…` | B (nulo) | não | `encerrado_operacional` | **sim (errado)** | rótulo errado na cobertura; **não entra em lote** |
| `bf9e2a20-…` | A | não | `encerrado_operacional` | não | nenhum: `acionado_mes` seria `false` com ou sem correção |
| `d09acf2a-…` | C | **sim** | — | não | nenhum: 0,144 s, mesmo dia, toda regra resolve igual |
| `ec324e37-…` | C | não | `liquidado_prime` | não | nenhum: `fidelizacao_ativa` já é `true` |

Teste direto do pior caso: `buscar_candidatos_acoes_massivas` com
`p_apenas_nunca_acionado = true` para 2024, 2025 e 2026 devolve 203, 6 e 3
linhas e **o aluno `26285c39` não está em nenhuma delas**. O rótulo
`nunca_acionado` está errado, mas não vira acionamento indevido em lote nenhum.

Também vale registrar o que o rótulo errado significa no papel: `26285c39` é o
único dos 61 com caso ativo, `status_jornada` "Em cobrança", responsável
`cobranca05@aelbra.com.br` e `saldo_total` **R$ 1.172,40**, acionado em 10/07
(`QUITADO_MANUAL`) com `casos.data_ultimo_acionamento` = 29/07. Para a cobertura
de ações massivas ele é "nunca acionado"; para o caso dele, não é.

### 4.3 Conta como "nunca acionado"?

Só os 16 nulos do grupo B podem. Desses, **15 estão com saldo zero e caso
`encerrado_operacional`**; **1** (`26285c39`) tem caso ativo e é o único a
aparecer rotulado no universo. Grupos A e C têm campo preenchido: não entram
nessa conta em nenhuma hipótese.

---

## 5. Recomendação por grupo

### Grupo A — 5 alunos — **corrigir**

Único grupo sem ambiguidade: a movimentação mais nova é ação massiva, que é
acionamento tanto pelo catálogo vivo (`eh_tipo_acionamento`) quanto pela lista de
3 tipos que o reparo de 28/08 escolheu. É o mesmo caso dos 11 de ontem.

* **valor:** `registrado_em` da própria `ACAO_MASSIVA_EXTERNA` — o registro que
  já existe, nunca inferência;
* **escopo:** os 5 ids da tabela 3.1, por id exato;
* **molde:** `supabase/migrations/20261020093853_corrige_dua_massiva_setembro.sql`
  serve como está — alvo "quem tem acionamento mais novo que o campo", trilha com
  o valor ANTES, idempotente, pós-condição que aborta se algo além do campo
  mudar;
* **ganho operacional:** **zero hoje** (nenhum dos 5 é elegível). O ganho é de
  consistência do histórico e dos painéis de penetração por ano.

### Grupo B — 51 alunos — **precisa de decisão da gestão** (não corrigir antes)

A pergunta não é "qual valor gravar", é **"`QUITADO_MANUAL`, `COMPROVANTE_ENVIADO_BAIXA`
e `LINK_ENVIADO_AO_ALUNO` são acionamento?"**. Hoje produção responde as duas
coisas ao mesmo tempo: o gatilho diz que sim, o reparo de 28/08 disse que não.

* **se a resposta for "são acionamento"**: corrigir os 51 com
  `registrado_em` da movimentação mais nova (mesmo molde do grupo A) **e** rever
  a lista de 3 tipos para que o próximo reparo não recrie o desvio;
* **se a resposta for "não são acionamento"**: **não corrigir nada** e, em vez
  disso, retirar esses tipos de `eh_tipo_acionamento` — ou separar as duas
  perguntas em duas funções ("é trabalho registrado" ≠ "é contato com o aluno"),
  porque hoje o gatilho carimba quitação manual como acionamento em toda a base,
  não só nestes 51;
* **urgência:** baixa. 50 dos 51 não são elegíveis para cobrança; o único efeito
  visível é o rótulo `nunca_acionado` de `26285c39` na cobertura;
* **o que NÃO fazer:** aplicar a `20261020093853` a estes 51 sem a decisão. Ela
  usa `eh_tipo_acionamento` como alvo, e isso escolheria o lado "é acionamento"
  em silêncio, desfazendo uma decisão tomada de propósito em 28/08.

### Grupo C — 5 alunos — **deixar como está; consertar a escrita, não as linhas**

Corrigir as 5 linhas não entrega nada: 0,008 s a 0,167 s de atraso no mesmo
segundo da mesma ação, e as duas datas resolvem idêntico em toda regra do
sistema (que é por dia). E seria enxugar gelo: a causa é estrutural e segue
viva.

* **o que resolve de verdade:** fazer a escrita do frontend respeitar a mesma
  guarda que o gatilho do banco já tem — "só grava se for mais novo que o que
  está lá". Duas formas, nenhuma aplicada aqui: (a) parar de escrever o campo no
  frontend e deixar o gatilho
  `fn_atualizar_ultimo_acionamento` ser o dono único, já que ele dispara em todo
  insert de movimentação de acionamento; ou (b) um gatilho
  `BEFORE UPDATE OF data_ultimo_acionamento` que rejeite valor menor que o
  atual — irmão do `trg_acionamento_nao_volta_para_nulo`, que hoje só barra a
  volta para nulo e deixa passar a volta para um valor mais antigo;
* **atenção, risco da opção (b):** uma trava "só para frente" impediria também
  **correções legítimas para trás**. A `20261020093853` só escreve para frente,
  então não é afetada, mas qualquer reversão por backup precisaria de porta
  própria. Decidir antes de implementar;
* **urgência:** baixa em efeito, mas é a única causa que ainda produz casos — 4
  em outubro.

### Dívida transversal — rastreabilidade do reparo de 28/08

`20260828020000` está em `origin/main` e **não** no ledger de produção, embora o
efeito esteja em prod (1.826 linhas). Recomendação: registrar a versão no ledger
com arquivo `-`, no padrão que a `docs/GATE-1-LEDGER.md` já usa para versão
aplicada à mão. Não é correção de dado; é fechar o buraco que fez este
diagnóstico depender de uma tabela de backup para reconstruir a história.

---

## Apêndice — grupo B completo (51 alunos)

`mais nova` e `campo` em horário de Brasília. `casos` é
`max(casos.data_ultimo_acionamento)` do aluno.

| aluno_id | tipo da mais nova | mais nova | campo | atraso (d) | casos |
| --- | --- | --- | --- | --- | --- |
| `224ecc7d-60ca-43f6-9287-4a26266e785d` | COMPROVANTE_ENVIADO_BAIXA | 06/07 17:04 | **nulo** | — | 29/07 |
| `696de365-0fe9-48e7-a32e-984ccc331927` | COMPROVANTE_ENVIADO_BAIXA | 08/07 13:58 | 03/07 14:50 | 5 | 29/07 |
| `1f381e30-eaa0-4767-abc3-d6f419583464` | QUITADO_MANUAL | 09/07 16:34 | **nulo** | — | 29/07 |
| `360b1509-1261-45b4-8eb7-19f00515cc00` | QUITADO_MANUAL | 09/07 17:47 | **nulo** | — | 29/07 |
| `94e84676-7ee1-424e-aaf2-497847b3b36c` | QUITADO_MANUAL | 10/07 13:44 | **nulo** | — | 29/07 |
| `79e03c96-5ed1-4e0a-9020-85d36162d5b7` | QUITADO_MANUAL | 10/07 14:08 | **nulo** | — | 29/07 |
| `26285c39-f8f7-41cd-9650-4bd47ef264be` | QUITADO_MANUAL | 10/07 15:07 | **nulo** | — | 29/07 |
| `0c2d7ab9-8bfe-4559-a4f6-cbc86e139638` | QUITADO_MANUAL | 13/07 17:51 | 06/07 13:32 | 7 | 29/07 |
| `22aa576e-678f-4211-ba75-732f52110153` | QUITADO_MANUAL | 16/07 17:08 | **nulo** | — | 29/07 |
| `e67b4d49-2443-4839-8108-566225f0aa0d` | QUITADO_MANUAL | 17/07 11:55 | **nulo** | — | 29/07 |
| `3ed1551c-e524-43de-a030-2587ba6491d8` | QUITADO_MANUAL | 17/07 12:14 | **nulo** | — | 29/07 |
| `16523de7-2959-4368-bec4-691dd622756b` | LINK_ENVIADO_AO_ALUNO | 20/07 16:46 | 20/07 16:40 | 0 | 20/07 |
| `a26de37b-1a8a-48bd-8a8b-e03d01bc5799` | COMPROVANTE_ENVIADO_BAIXA | 20/07 19:20 | 20/07 13:55 | 0 | 20/07 |
| `71b79eb3-f3e9-43cb-927b-8bc65cf66811` | COMPROVANTE_ENVIADO_BAIXA | 23/07 09:18 | 22/07 13:31 | 1 | 22/07 |
| `c4dc8d60-f47f-4dfb-8072-4c0d30397fe5` | QUITADO_MANUAL | 27/07 12:09 | **nulo** | — | 27/07 |
| `74747c16-d2dd-4d74-a696-40ad36d17434` | COMPROVANTE_ENVIADO_BAIXA | 28/07 18:06 | 28/07 16:34 | 0 | 28/07 |
| `5a16b28a-ffd9-4813-92b8-32331bb5dba6` | COMPROVANTE_ENVIADO_BAIXA | 29/07 19:46 | 28/07 16:16 | 1 | 29/07 |
| `15cc76c2-f3ed-4690-a01c-030c19ce549e` | COMPROVANTE_ENVIADO_BAIXA | 30/07 09:54 | 29/07 15:16 | 1 | 30/07 |
| `4a768d6a-eedf-4dec-b23f-a9e340fcc378` | COMPROVANTE_ENVIADO_BAIXA | 30/07 10:24 | 29/07 15:19 | 1 | 30/07 |
| `096e5b01-3aa9-4e01-ad23-f492f7e07e80` | COMPROVANTE_ENVIADO_BAIXA | 06/08 14:28 | 06/08 13:51 | 0 | 06/08 |
| `b7ac4000-5a55-4cb3-9164-2eb461aebd24` | COMPROVANTE_ENVIADO_BAIXA | 10/08 14:45 | 10/08 14:07 | 0 | 10/08 |
| `dc5088fe-0a40-40ab-9f54-8f70479145c7` | QUITADO_MANUAL | 24/08 09:58 | 21/08 15:15 | 3 | 24/08 |
| `cf8f41aa-aa92-4a9c-bc2d-488fc30b2d7e` | QUITADO_MANUAL | 26/08 11:05 | 26/08 10:55 | 0 | 26/08 |
| `5eb28496-a860-4670-ad0c-9be4eb09e2f3` | QUITADO_MANUAL | 26/08 11:23 | 26/08 09:59 | 0 | 26/08 |
| `fbbb8674-d233-41f8-a7a6-fcdc97f57813` | QUITADO_MANUAL | 26/08 11:40 | 25/08 18:03 | 1 | 26/08 |
| `84050a0c-a896-40ef-b0ca-af9df99b85b7` | QUITADO_MANUAL | 26/08 11:40 | 25/08 18:03 | 1 | 26/08 |
| `c9778151-d0a0-4ac0-9373-c9a1beef09ae` | QUITADO_MANUAL | 26/08 13:26 | 26/08 13:17 | 0 | 26/08 |
| `02a178c4-f717-470e-b21a-5248d929b9e6` | QUITADO_MANUAL | 26/08 13:27 | 26/08 10:40 | 0 | 26/08 |
| `4b1b2b17-c660-4e49-bd7d-a9441fa9be77` | QUITADO_MANUAL | 26/08 15:05 | 20/08 16:06 | 6 | 26/08 |
| `c66b8a52-45eb-40c6-ad84-2352ea45143f` | QUITADO_MANUAL | 26/08 16:03 | 06/08 16:57 | 20 | 26/08 |
| `1408c88d-d7a4-451d-873d-5af8f941fa07` | QUITADO_MANUAL | 27/08 12:04 | 18/08 15:10 | 9 | 27/08 |
| `fe2c4095-9237-4f9a-aa77-d0c476a79db6` | QUITADO_MANUAL | 27/08 17:24 | 16/07 19:31 | 42 | 27/08 |
| `509e67af-2a05-426a-8b2e-51adb669f187` | QUITADO_MANUAL | 27/08 17:25 | 15/07 11:50 | 43 | 27/08 |
| `097fdb57-5bcd-4aa3-8b46-6ba2c161fbaf` | QUITADO_MANUAL | 27/08 17:30 | **nulo** | — | 27/08 |
| `6fbacc31-6bd9-4a16-b4dd-01ec638a1053` | QUITADO_MANUAL | 27/08 17:31 | **nulo** | — | 27/08 |
| `de7efbd9-cd93-4f9b-92d3-0b5afcd557a9` | QUITADO_MANUAL | 27/08 17:32 | 25/07 10:47 | 33 | 27/08 |
| `48374e9b-874a-4fda-8178-310ccf93cb51` | QUITADO_MANUAL | 27/08 17:34 | 28/07 09:57 | 30 | 27/08 |
| `95ab885e-7b90-426f-83b5-bdafa16b7f0c` | QUITADO_MANUAL | 27/08 17:34 | 10/07 14:22 | 48 | 27/08 |
| `b2326784-8fe1-4713-94f9-9138778087fa` | QUITADO_MANUAL | 27/08 17:36 | 24/07 15:28 | 34 | 27/08 |
| `2d21429d-aed1-443f-acee-e8af4f9278d1` | QUITADO_MANUAL | 27/08 19:38 | **nulo** | — | 27/08 |
| `4849c995-c316-4e53-bb97-f58be300ae45` | QUITADO_MANUAL | 27/08 19:38 | 20/07 14:27 | 38 | 27/08 |
| `03ec6eda-2756-45a2-bf0a-ad4a72d969c3` | QUITADO_MANUAL | 27/08 19:40 | 20/07 15:33 | 38 | 27/08 |
| `b1d6137a-cc83-4a86-bb73-1d8b9802d9ff` | QUITADO_MANUAL | 27/08 19:47 | 10/07 16:02 | 48 | 27/08 |
| `b19e3448-7321-4fd7-bd93-2dbe821df8b7` | QUITADO_MANUAL | 27/08 19:50 | 16/07 14:08 | 42 | 27/08 |
| `9cc8fd83-4f78-4c0b-b4fc-af71b479f38b` | QUITADO_MANUAL | 27/08 19:52 | 27/07 09:58 | 31 | 27/08 |
| `1067e990-3b09-47c0-addb-ab6f24a9a3aa` | QUITADO_MANUAL | 27/08 19:54 | **nulo** | — | 27/08 |
| `70ae6114-3b2f-4517-b0de-a145238b3248` | QUITADO_MANUAL | 27/08 20:00 | **nulo** | — | 27/08 |
| `15aeaaae-6361-4af6-aa55-2a4e99bb1db7` | QUITADO_MANUAL | 27/08 20:22 | **nulo** | — | 27/08 |
| `aad2d8f0-ae31-4ef9-99da-2cb651316015` | QUITADO_MANUAL | 27/08 20:24 | 17/07 14:22 | 41 | 27/08 |
| `19de9bfe-f7ee-4291-81e6-a250dfad6534` | QUITADO_MANUAL | 27/08 20:46 | 15/07 17:35 | 43 | 27/08 |
| `3d787b6d-e522-4e75-9014-d9d0b35492f3` | QUITADO_MANUAL | 27/08 20:46 | 15/07 17:35 | 43 | 27/08 |

---

## Como reproduzir

```sql
-- o universo
with universo as (
  select a.id as aluno_id, a.data_ultimo_acionamento as dua,
         m.registrado_em as mov_max, m.tipo as mov_tipo
    from public.alunos a
    join lateral (
      select x.registrado_em, x.tipo
        from public.aluno_movimentacoes x
       where x.aluno_id = a.id::text
         and public.eh_tipo_acionamento(x.tipo)
       order by x.registrado_em desc, x.id desc
       limit 1) m on true
   where a.data_ultimo_acionamento is null
      or a.data_ultimo_acionamento < m.registrado_em)
select case when mov_tipo in ('ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL') then 'A'
            when mov_max - dua < interval '1 second' then 'C'
            else 'B' end as grupo,
       count(*), count(*) filter (where dua is null) as nulos
  from universo group by 1 order by 1;
-- esperado em 20/10/2026: A 5 / B 51 (16 nulos) / C 5
```

A prova da troca de dono (56 de 56) cruza cada aluno com
`aluno_movimentacoes` onde `tipo = 'REDISTRIBUICAO_SINCRONIZACAO'`,
`registrado_em > mov_max` e
`operador_anterior_email is distinct from operador_novo_email`. As duas tabelas
de trilha dos reparos anteriores são
`public._backup_alunos_dua_20260821` (21/08) e
`public._backup_acionamento_restaurado_20260828` (28/08).
