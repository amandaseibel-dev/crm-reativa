# Retenção e limpeza das importações — acordos, projeção e borderô

**Data:** 07/11/2026 · **Natureza:** diagnóstico SOMENTE LEITURA
**Ambiente medido:** PRODUÇÃO `ahattpqrjmhkzsmnbdzs` (confirmado por
`plugins/reativa-one/scripts/ambiente.sh`; `config.toml` aponta staging e **não**
é o destino remoto)
**Nada foi apagado, alterado, publicado ou migrado.** Todas as consultas foram
`SELECT` de catálogo (`pg_class`, `pg_proc`, `information_schema`, `cron.job`) e
agregados em tabelas pequenas. Nenhuma varredura de tabela grande.

---

## 0. Resumo em cinco linhas

1. O dado bruto da importação **quase não existe** neste sistema: `borderos`,
   `base_importacoes` e `baixas_importadas` estão com **0 linhas**. A importação
   grava direto no registro financeiro definitivo.
2. O que ocupa espaço **não é** staging de importação: é `whatsapp_webhook_eventos`
   (654 MB), `historico_operadores_alunos` (351 MB), `audit_log` (276 MB) e os
   buckets `comprovantes-pagamento` (2.167 MB) e `termos-acordo` (488 MB) — prova
   financeira, não descartável.
3. O problema real e medido **não é bytes, é número de objetos**: `public` tem
   **1.468 tabelas**, das quais **1.196 são tabelas de backup** (`_backup*`,
   `_excecao*`) — 81%. Dessas, **548** são `_backup_pos_import_<timestamp>`.
4. Esse crescimento **já parou**: a mais recente é `_backup_pos_import_20260924174025`
   (24/09/2026) e o cron que a gerava está `active=false`.
5. Impacto em **armazenamento** dessas tabelas: **~82 MB** dos 2.791 MB do banco
   (2,9%). Impacto em **desempenho**: plausível e com mecanismo conhecido, mas
   **NÃO COMPROVADO** — nenhum número medido de latência está nesta frente.

---

## 1. Onde fica o quê

### (a) Arquivos originais importados

| Importação | Arquivo original é guardado? | Onde | Evidência |
|---|---|---|---|
| **Acordos** | **Sim, desde 26/10/2026** | bucket `importacoes-acordos` | upload em [ImportacaoAcordos.jsx:255-257](../../src/pages/ImportacaoAcordos.jsx#L255); registro via RPC `registrar_importacao_acordo_arquivo` ([:266](../../src/pages/ImportacaoAcordos.jsx#L266)) |
| **Borderô** | **NÃO** | — | [Borderos.jsx](../../src/pages/Borderos.jsx) calcula SHA-256 e **recusa** sem ele ([:404-414](../../src/pages/Borderos.jsx#L404)), mas nunca faz `storage.upload`. Grep de `storage.from` em `src/` retorna só `elogios-prints`, `documentos-operadores`, `importacoes-acordos` |
| **Projeção** | **NÃO** no caminho da tela | — | `projecao_importar_pagamentos` recebe `p_linhas` já parseadas ([ProjecaoHoraHora.jsx:841](../../src/pages/ProjecaoHoraHora.jsx#L841)) |

**Medido no bucket `importacoes-acordos`: 21 objetos, 485 kB, de 26/10 a 06/11.**
Contra **237** importações de acordo registradas desde 02/07. Ou seja: o arquivo
original existe para **21 de 237** importações de acordo (8,9%) e para **zero**
dos 160 borderôs.

> Isto é o achado mais importante do ponto 1: não há o que "limpar" em arquivo
> original — há o oposto, uma lacuna de lastro.

### (b) Dados temporários / staging

| Tabela | Linhas (exato) | Tamanho | Situação |
|---|---|---|---|
| `borderos` | **0** | 32 kB | estrutura existe (`numero_bordero`, `dados jsonb`, `importacao_id`), **nunca usada ou já drenada** |
| `base_importacoes` | **0** | 16 kB | idem (`nome_aba`, `dados jsonb`) |
| `baixas_importadas` | **0** | 128 kB | idem, com campos de aprovação/rejeição |
| `titulo_presenca_importacao` | ~36.011 (est.) | 7.376 kB | **não é staging descartável**: é a presença de título por escopo de extração, lastro da conferência |
| `extracao_escopo` | 128 | 336 kB | metadados de extração (`arquivo_hash`, `linhas_arquivo`, validação) — **trilha, não staging** |
| `importacao_acordo_critica` | 159 | 136 kB | críticas por linha, 26/10 a 06/11 |

Dentro dos chunks da importação de acordos o temporário é **tabela temporária de
transação** (`create temp table _alvo on commit drop` em
`acordos_pos_importacao`), que desaparece sozinha. Não há staging persistente.

### (c) Históricos de processamento / log

| Objeto | Linhas | Tamanho | Papel |
|---|---|---|---|
| `importacoes` | **897** (02/07 → 06/11) | 408 kB | **a trilha central**. Colunas: `tipo`, `referencia`, `arquivo_nome`, `usuario`, `qtd_registros`, `status`, `substitui_importacao_id`, `substituido_por/_em`, `excluido_por/_em`, `motivo_exclusao`, `motivo_substituicao`, `reprocessado_por/_em` |
| `importacoes_acordos` | 237 | 88 kB | por importação: `arquivo_sha256`, `arquivo_bytes`, `arquivo_path`, `linhas_arquivo`, `parcelas`, `acordos`, `cpfs`, `titulos_inseridos`, `total` |
| `academico_importacoes` | 29 (só 04/08) | 216 kB | acadêmico, parado |
| `importacao_acordo_critica` | 159 | 136 kB | críticas |
| `auditoria` / `audit_log` | — | 7.768 kB / **276 MB** | auditoria geral, fora do recorte |

Distribuição de `importacoes` por tipo: `PROJECAO_DIARIA=578`, `BORDERO=160`,
`ACORDOS=157`, `RECONCILIACAO_PAGAMENTOS=1`, `CORRECAO_DUPLICIDADE=1`.
Por status: `CONCLUIDO=499`, `SUBSTITUIDA=238`, `Concluída=157` (**duas grafias
de status concluído — divergência a registrar**), `EXCLUIDA=2`, `PROCESSANDO=1`.

RPCs de leitura da trilha: `relatorio_importacoes_bordero`
([Importacoes.jsx:24](../../src/pages/Importacoes.jsx#L24)),
`listar_importacoes_acordos` ([ImportacaoAcordos.jsx:92](../../src/pages/ImportacaoAcordos.jsx#L92)),
`importacao_conferencia_ler`, `importacao_conferencia_arquivos`.

### (d) Registros financeiros definitivos

Estes são o destino da importação e **não entram em nenhuma proposta de
retenção**: `acordos`, `acordos_titulos` (33 MB), `parcelas` (9.344 kB),
`pagamentos` (14 MB), `alunos` (58 MB), `acordo_titulo_vinculo` (5.504 kB),
`recuperacao_historica` (8.496 kB, 21.994 linhas).

O borderô grava direto nelas: `alunos` ([Borderos.jsx:707,719](../../src/pages/Borderos.jsx#L707)),
`acordos_titulos` ([:737,745](../../src/pages/Borderos.jsx#L737)),
`acordos` ([:762,796](../../src/pages/Borderos.jsx#L762)),
`parcelas` ([:771,780](../../src/pages/Borderos.jsx#L771)).

### Edge Functions e buckets, por nome

Edge Functions com relação à frente: `santander-importar`, `santander-previa`,
`prev-sincronizar`. **Observação vinda de memória de sessão, não reconferida
aqui:** há registro de que `santander-importar` nunca existiu em produção e de
que a caixa "Ler no servidor" está oculta (`SERVIDOR_DISPONIVEL=false`, PR #824).
**Tratar como NÃO COMPROVADO neste documento** — não foi verificado contra o
projeto ligado.

Buckets medidos (`storage.objects`, 9 buckets, 2.698 objetos):

| Bucket | Objetos | Tamanho | Período |
|---|---|---|---|
| `comprovantes-pagamento` | 751 | **2.167 MB** | 01/07 → 07/11 |
| `termos-acordo` | 1.336 | **488 MB** | 02/07 → 07/11 |
| `whatsapp-midia` | 528 | 140 MB | 19/08 → 07/11 |
| `envios-financeiro` | 116 | 21 MB | 16/07 → 06/11 |
| `fotos-perfil` | 17 | 13 MB | 02/07 → 24/07 |
| `sugestoes-prints` | 25 | 2.057 kB | 07/08 → 03/11 |
| `elogios-prints` | 18 | 1.282 kB | 14/07 → 03/11 |
| **`importacoes-acordos`** | **21** | **485 kB** | 26/10 → 06/11 |
| `tv-imagens` | 1 | 69 kB | 21/08 |

---

## 2. Atualiza ou acumula? Chave de idempotência

| Fluxo | Comportamento | Chave de idempotência | Reimportação do mesmo arquivo |
|---|---|---|---|
| **Projeção** | **Substitui** | `(mes_referencia, arquivo_nome)` via RPC `projecao_checar_importacao_existente` ([ProjecaoHoraHora.jsx:796](../../src/pages/ProjecaoHoraHora.jsx#L796)) | Detectada. A tela pergunta e exige **motivo**; a importação antiga vira `status='SUBSTITUIDA'` e fica apontada por `substitui_importacao_id`. **238 linhas em SUBSTITUIDA** — a linha de trilha acumula, o dado financeiro não duplica |
| **Acordos** | **Acumula por chunk, com crítica** | `arquivo_sha256` em `importacoes_acordos`; hash obrigatório antes de gravar | Não há bloqueio automático por hash no código da tela; a defesa é a crítica (`importacao_acordo_critica`) e o `sha256` registrado |
| **Borderô** | **Acumula, com aviso** | `(tipo='BORDERO', referencia=<nº do borderô>, status='CONCLUIDO')` ([Borderos.jsx:359-368](../../src/pages/Borderos.jsx#L359)) | **Avisa e NÃO bloqueia** — comentário no próprio código: "Nao bloqueia (pode ser reforço de dados de propósito), so deixa bem visivel antes de confirmar". A proteção efetiva contra duplicata de linha é `upsert(..., { onConflict, ignoreDuplicates: true })` ([Borderos.jsx:137-138](../../src/pages/Borderos.jsx#L137)) |

**Conclusão do ponto 2:** só a projeção tem idempotência de verdade (substituição
com motivo). Borderô e acordos dependem de aviso ao operador e de `onConflict` na
linha. Existe lastro das reimportações que já ocorreram:
`_backup_parcelas_dup_reimport_20260805`, `_backup_acordos_dup_reimport_20260805`,
`_backup_alunos_dup_bordero723_20261009`, `_backup_shadow_dup_bordero723_20261009`
— **prova de que reimportação acontece e que já exigiu reparo**.

---

## 3. Volume, idade e crescimento (medido por catálogo)

Banco inteiro: **2.791 MB**. Esquema `public`: **2.495 MB** em **1.468 tabelas**.

### Onde está o espaço (top, `pg_total_relation_size`)

| Tabela | Total | Linhas est. |
|---|---|---|
| `whatsapp_webhook_eventos` | 654 MB | 149.600 |
| `historico_operadores_alunos` | 351 MB | 982.412 |
| `audit_log` | 276 MB | 203.626 |
| `historico_agendamentos` | 221 MB | 827.047 |
| `prime_extrato` | 163 MB | 419.049 |
| `aluno_movimentacoes` | 132 MB | 228.532 |
| `prime_titulo_semestre` | 68 MB | 416.417 |

**Nenhuma dessas é importação de acordo, projeção ou borderô.** O recorte pedido
não é onde está o espaço.

### Tabelas da frente (todas pequenas)

`recuperacao_historica` 8.496 kB · `titulo_presenca_importacao` 7.376 kB ·
`reconciliacao_prime` 6.016 kB · `projecao_snapshot_pagamentos` 5.480 kB
(11.235 linhas, 03/09 → 06/11) · `importacoes` 408 kB · `extracao_escopo` 336 kB ·
`academico_importacoes` 216 kB · `importacao_acordo_critica` 136 kB ·
`importacoes_acordos` 88 kB · `borderos` 32 kB (0 linhas) ·
`base_importacoes` 16 kB (0 linhas) · `baixas_importadas` 128 kB (0 linhas).

**Soma das tabelas de trilha e staging da frente: menos de 30 MB.**

### O número que importa: contagem de objetos

| Categoria | Qtd. de tabelas | Tamanho somado |
|---|---|---|
| `_backup_pos_import_<timestamp>` | **548** | 9.616 kB |
| outras `_backup*` / `_excecao*` | **648** | 58 MB |
| `*_bkp_YYYYMMDD` / `*backup_YYYYMMDD` | 10 | 14 MB |
| **subtotal backup** | **1.196** | **~82 MB** |
| total `public` | 1.468 | 2.495 MB |

**1.196 de 1.468 tabelas (81,5%) são tabelas de backup, e somam 2,9% do banco.**

### Idade e crescimento

- `_backup_pos_import_*`: de **20260901174001** a **20260924174025**. Cadência
  horária. **Parou em 24/09/2026** — 44 dias sem nova.
- Criadas por `public.acordos_pos_importacao()` — única função em `public` cujo
  corpo menciona `_backup_pos_import` (consulta em `pg_proc.prosrc`).
  **Nenhuma função lê essas tabelas**: a mesma consulta não encontra leitor.
  São write-only hoje.
- Os crons que acionavam o fluxo estão **desligados**: `fluxo_acordos_diario`
  `active=false`, `fluxo_pagamentos_horario` `active=false`,
  `acordo_vinculo_automatico` `active=false` (`cron.job`).
- `_backup_pos_import_*` de 8192 bytes = **uma página de dados**, portanto pouco
  conteúdo. **Cuidado:** `reltuples = -1` significa *nunca analisada*, **não
  vazia**. A contagem exata ficou para a simulação do item 7 — **já executada**,
  resultado em
  [RESULTADO-SIMULACAO-E-ACHADOS-2026-11-07.md](RESULTADO-SIMULACAO-E-ACHADOS-2026-11-07.md):
  **213 vazias e 335 com conteúdo (11.645 linhas)**. A maioria **não** está vazia.

### Precedente de retenção já existente em produção

`cron.job` já tem rotinas de expurgo aprovadas e rodando:
`whatsapp_retencao_mensal [10 4 1 * *]`, `whatsapp_expurgar_eventos_diario
[25 4 * * *]`, `desfazer_expurgar [20 4 * * *]`, e as faxinas pontuais
`faxina_webhook_eventos_unica`, `faxina_audit_log_unica`,
`faxina_prime_titulo_semestre_unica`. Ou seja: **o padrão de retenção automática
já existe neste banco** e não precisa ser inventado.

---

## 4. O que ainda é necessário — e por quê

### Nunca sai (prova financeira ou lastro de reconstrução)

| O quê | Por quê |
|---|---|
| `acordos`, `acordos_titulos`, `parcelas`, `pagamentos`, `alunos`, `acordo_titulo_vinculo`, `recuperacao_historica` | registro financeiro definitivo |
| `importacoes` (897 linhas, 408 kB) | **única trilha do borderô**. Como `borderos` está com 0 linhas e nenhum arquivo de borderô foi guardado, esta tabela é o **único** registro de que o borderô nº X entrou, quando, por quem, com quantas linhas. Apagar é perder a auditoria de 160 borderôs |
| `importacoes_acordos` (237 linhas, 88 kB) | guarda `arquivo_sha256`/`arquivo_bytes`/`linhas_arquivo` — identidade do arquivo mesmo quando o arquivo não existe mais |
| bucket `importacoes-acordos` (21 objetos, 485 kB) | **são os únicos arquivos originais que existem**. Além de minúsculos, cobrem só 8,9% das importações |
| `extracao_escopo` + `titulo_presenca_importacao` | lastro de conferência Prime; `titulo_presenca_importacao` é a presença de título por escopo |
| `comprovantes-pagamento`, `termos-acordo` | comprovante e termo assinado |
| `_backup_*_dup_reimport_*`, `_backup_*_bordero723_*`, `_backup_parcelas_acordo_erro_import` (3.728 kB) | **reparo de reimportação já ocorrido**. É exatamente o caso que a Amanda levantou: borderô usado em reimportação não é descartável |

### Regra explícita que vale aqui

**Borderô terminado ≠ borderô descartável.** Com `borderos` vazio e sem arquivo
original, a reimportação de um borderô hoje depende de a ULBRA reenviar a
planilha. A trilha em `importacoes` é o que permite saber *qual* planilha pedir.

**Pagamento pendente de conciliação não é descartável.** Há risco financeiro vivo
registrado no projeto (pagamento em parcela cancelada, fila de revisão de baixas,
acordos importados sem vínculo de títulos, prévia do Santander). Enquanto essas
frentes estiverem abertas, nada que as lastreie entra em expurgo — e isto inclui
os `_backup_*` de reparo acima.

### Recuperação de falha

A recuperação de falha de importação hoje é:
`status='PROCESSANDO'` parado em `importacoes` (**1 linha nesse estado agora** —
vale conferir se é uma importação travada), `motivo_exclusao`/`excluido_por` para
exclusão, `reprocessado_por/_em` para reprocesso (`projecao_reprocessar_importacao`),
e `projecao_excluir_importacao`. Nada disso depende de dado bruto — depende da
trilha. **Mais um motivo para a trilha ser a parte intocável.**

---

## 5. Impacto comprovado

| Dimensão | Veredito |
|---|---|
| **Armazenamento** | **COMPROVADO, e pequeno.** As 1.196 tabelas de backup somam ~82 MB de 2.791 MB (2,9%). As tabelas de trilha/staging da frente somam <30 MB. O espaço do banco está em webhook/histórico/audit e nos buckets de comprovante — fora do recorte |
| **Custo** | **NÃO COMPROVADO.** Nenhuma fatura, linha de billing ou preço por GB foi consultado nesta frente. 82 MB em um banco de 2,8 GB não sustenta afirmação de custo |
| **Desempenho** | **NÃO COMPROVADO.** Existe mecanismo plausível e conhecido — 1.468 relações em `public` encarecem introspecção de catálogo (recarga de cache de schema do PostgREST, `pg_dump`, autovacuum percorrendo 1.196 relações, qualquer consulta a `information_schema`), e este banco **já saturou** antes. Mas **nenhuma latência foi medida** aqui. Afirmar ganho de desempenho sem antes/depois medido seria exatamente o erro de "critério sem grupo de controle" |
| **Risco operacional atual** | **COMPROVADO por catálogo:** 1 importação em `PROCESSANDO` (Borderô 333, **128 dias**, com **472 títulos gravados**); duas grafias de status concluído (`CONCLUIDO` e `Concluída`) convivendo em `importacoes`; arquivo original ausente para 91% das importações de acordo e 100% dos borderôs |
| **Segurança dessas 548 tabelas** | **COMPROVADO:** RLS habilitado em todas, **0 policies**, e **`authenticated` com SELECT/INSERT/UPDATE/DELETE/TRUNCATE** nas 548 (3.815 grants). `TRUNCATE` **não passa por RLS** — qualquer token autenticado apaga o lastro de desfazer. Detalhe em [RESULTADO-SIMULACAO-E-ACHADOS-2026-11-07.md](RESULTADO-SIMULACAO-E-ACHADOS-2026-11-07.md) |

---

## 6. Proposta de retenção — três classes, com prazo justificado

> **Nada abaixo é regra fechada.** São prazos **propostos para decisão da
> Amanda**, cada um com o motivo nomeado: o que o prazo protege e o que se perde
> quando vence. Nada está implementado: sem migration, sem cron, sem exclusão.

**Princípio adotado nesta versão:** "para sempre" só sobrevive onde houver motivo
nomeado. Onde o único motivo seria "ainda não medimos", o prazo é **provisório** e
vem acompanhado do que precisa ser medido para confirmá-lo.

### Classe (a) — Registro financeiro definitivo

O que é: `acordos`, `acordos_titulos`, `parcelas`, `pagamentos`, `alunos`,
`acordo_titulo_vinculo`, `recuperacao_historica`, e os buckets
`comprovantes-pagamento` e `termos-acordo`.

| Prazo proposto | O que protege | O que se perde ao vencer |
|---|---|---|
| **Permanente, sem prazo** | Obrigação fiscal e civil sobre dívida de mensalidade, prova de pagamento e termo assinado. É o registro do crédito e da sua quitação — não é cópia de nada | A dívida e a quitação deixam de ter prova. Perda não recuperável e com exposição legal |

**Motivo nomeado:** obrigação legal/fiscal. Nada aqui é derivado — é o original.
Esta é a única classe onde "permanente" não precisa de prazo de revisão.

**Observação para quem decidir:** o prazo de guarda fiscal no Brasil é
tipicamente contado em anos após a extinção do crédito, e **a definição exata é
jurídica, não técnica — não foi apurada nesta frente**. Como o volume desta
classe não é o problema (o espaço está em webhook/histórico/audit), não há ganho
em arbitrar um número aqui. **Se a gestão quiser prazo nominal, isso precisa vir
do jurídico/contábil, não deste documento.**

### Classe (b) — Auditoria e trilha

O que é: `importacoes` (897 linhas), `importacoes_acordos` (237),
`academico_importacoes` (29), `importacao_acordo_critica` (159),
`extracao_escopo` (128), `titulo_presenca_importacao` (~36 mil),
`_backup_*` de reparo de reimportação, e as 548 `_backup_pos_import_*`.

| Sub-item | Prazo proposto | O que protege | O que se perde ao vencer |
|---|---|---|---|
| `importacoes` + `importacoes_acordos` | **Igual à classe (a): acompanha o registro financeiro** | **Janela de reconstrução de vínculo.** Com `borderos` vazio e sem arquivo de borderô, é o **único** registro de que o borderô nº X entrou, quando, por quem, com quantas linhas. É o que permite saber *qual* planilha pedir à ULBRA | A auditoria de 160 borderôs e a possibilidade de pedir reenvio direcionado. 408 + 88 kB — não há ganho nenhum em apagar |
| `importacao_acordo_critica`, `extracao_escopo` | **Provisório: 24 meses** | Prova de que a importação teve ou não crítica, e o escopo declarado da extração | A capacidade de responder "essa importação já tinha problema?" sobre um período fechado |
| `titulo_presenca_importacao` | **Provisório: acompanha a conferência Prime** | Presença de título por escopo — lastro da conferência | Prova de que um título estava (ou não) no escopo conferido |
| `_backup_*` de reparo (`dup_reimport`, `bordero723`, `parcelas_acordo_erro_import`) | **Permanente até o reparo ser declarado encerrado, por escrito** | **Prova de reparo.** São o antes/depois de correções de reimportação que já aconteceram | A prova de que um ajuste financeiro foi legítimo. É exatamente o caso que motivou esta frente |
| **548 `_backup_pos_import_*`** | **Provisório: 12 meses após o encerramento das frentes de conciliação em aberto** | **Lastro de desfazer** de `acordos_pos_importacao`, que marca título como pago e cria vínculo. 335 delas guardam 11.645 linhas | A possibilidade de desfazer por id uma marcação de pagamento. **Com PITR desligado, não há outro caminho de volta** |

**O que precisa ser medido para confirmar os prazos provisórios:**
1. encerramento formal das frentes de conciliação citadas no item 4 (enquanto
   houver pagamento pendente de conciliação, o prazo não começa a contar);
2. que `acordos_pos_importacao` siga **sem nenhum leitor** (hoje: confirmado, 0);
3. desempenho — se o ganho de remover objetos de catálogo é real (hoje: **não
   comprovado**).

**As 213 comprovadamente vazias são a exceção:** não guardam lastro de nada, e
podem sair sem prazo de espera. São 1.704 kB e 213 dos 1.468 objetos.

### Classe (c) — Arquivo original de importação

O que é: bucket `importacoes-acordos` (21 objetos, 485 kB) e o arquivo de borderô
— **que não existe**.

| Sub-item | Prazo proposto | O que protege | O que se perde ao vencer |
|---|---|---|---|
| Arquivo de acordo no bucket | **Provisório: permanente enquanto a cobertura for parcial** | **Janela de reimportação.** São os únicos originais que existem, e cobrem 21 de 237 importações (8,9%) | O único insumo para reimportar sem depender de reenvio da ULBRA |
| Arquivo de borderô | **não se aplica — não é guardado** | — | Já perdido: a reimportação do borderô depende de a ULBRA reenviar a planilha |

**O que precisa ser medido para confirmar:** cobertura. **Enquanto for 8,9%, a
discussão de prazo é prematura** — 485 kB não justificam prazo nenhum. O prazo
só passa a fazer sentido depois de (1) a cobertura chegar perto de 100% e (2)
haver uma série de ao menos 12 meses para dizer quanto cresce por mês.

**A decisão real desta classe não é de retenção, é de produto:** passar a guardar
o arquivo de borderô (o hash SHA-256 já é obrigatório e o bucket já existe para
acordos) ou aceitar formalmente a dependência do reenvio da ULBRA.

### Fora das três classes

| Item | Proposta |
|---|---|
| **Staging vazio** (`borderos`, `base_importacoes`, `baixas_importadas`, 176 kB) | **Não apagar a estrutura.** Está vazia e `borderos` tem `importacao_id`. Remover tabela já derrubou tela neste projeto. Conferir antes se algum caminho ainda escreve |
| **Outras 648 `_backup*` / `_excecao*`** (58 MB) | **Caso a caso, nome por nome, fora desta frente.** Tratar como lote é o risco alto |
| **`projecao_snapshot_pagamentos`** (11.235 linhas) | Não é importação — alimenta projeção e meta. Fica |

### Trilha compacta a preservar quando o bruto sair

Já existe e **já é compacta**: `importacoes` + `importacoes_acordos` dão
**quem importou** (`usuario`, `importado_por`), **quando** (`created_at`,
`importado_em`), **qual arquivo** (`arquivo_nome`, `arquivo_sha256`,
`arquivo_bytes`, `arquivo_path`), **quantas linhas** (`qtd_registros`,
`linhas_arquivo`, `linhas_fora_do_escopo`) e **resultado** (`status`,
`parcelas`, `acordos`, `cpfs`, `titulos_inseridos`, `total`,
`motivo_substituicao`, `motivo_exclusao`).

**Nenhuma tabela nova é necessária.** A única lacuna é a divergência de grafia em
`status` (`CONCLUIDO` vs `Concluída`).

> **Correção de um erro deste documento.** A primeira versão afirmava que "qualquer
> filtro por status concluído erra por 157 linhas hoje". **Isso está errado.** A
> verificação posterior mostrou que todo consumidor de `importacoes.status` é
> recortado por `tipo` na origem (`relatorio_importacoes_bordero` tem
> `where i.tipo = 'BORDERO'`; `importacao_conferencia_arquivos` tem
> `where i.tipo in ('PROJECAO_DIARIA','PROJECAO_RETROATIVA')`), e as 157 linhas
> `Concluída` são **todas** de `tipo='ACORDOS'`. Nenhum filtro em produção é
> afetado hoje. É armadilha latente, não defeito ativo. Detalhe e correção
> preparada em
> [RESULTADO-SIMULACAO-E-ACHADOS-2026-11-07.md](RESULTADO-SIMULACAO-E-ACHADOS-2026-11-07.md).

### O que esta frente NÃO propõe

Sem exclusão em lote. Sem rotina automática. Sem migration. Sem publicação de
Edge Function. Execução — se houver — é da sessão principal, com autorização
explícita da Amanda, e com backup + SQL por id, porque **PITR não está
habilitado** e `DROP TABLE` aqui não tem volta.

---

## 7. Simulação (não aplicada)

Arquivo: [`simulacao-retencao-importacoes.sql`](simulacao-retencao-importacoes.sql)

Apenas `SELECT` de contagem e tamanho. Nenhum `DROP`, `DELETE`, `TRUNCATE` ou
`UPDATE`. Entrega, por categoria: quantidade de objetos, tamanho somado, e a
contagem **exata** de linhas das 548 `_backup_pos_import_*` (que `reltuples` não
responde), separando as realmente vazias das que têm conteúdo.

**Atualização de 07/11/2026 — o bloco 4 está aposentado.** A contagem exata com
`count(*)` nas 548 relações **foi executada uma vez**, e o resultado está no
RESULTADO (213 vazias / 335 com conteúdo). Por decisão da gestão, **não se conta
linha mais**: o caminho sancionado passa a ser o **bloco 4-SEQ**, que pergunta
apenas `exists (select 1 … limit 1)`, **uma relação por vez**, com
`set local statement_timeout` **conferido por `show statement_timeout`** — porque
`statement_timeout` em `proconfig` **não rearma** — e com **regra de parada
explícita** ao primeiro sinal de impacto. Resultado parcial com ponto de parada
declarado é entrega válida; varredura completa que derruba o banco não é.

O bloco 4 foi mantido no arquivo **comentado**, como registro do que de fato
rodou, marcado para nunca mais rodar.

---

## 8. Pendências que este diagnóstico deixa

1. **Decisão da Amanda** sobre as três levas do item 6.
2. ~~1 importação em `PROCESSANDO` — conferir~~ → **investigada em 07/11**:
   Borderô 333, travada há 128 dias, **com gravação parcial de 472 títulos**,
   reimportada e concluída em 28/10 **sem duplicar nada**. Ver
   [RESULTADO-SIMULACAO-E-ACHADOS-2026-11-07.md](RESULTADO-SIMULACAO-E-ACHADOS-2026-11-07.md).
3. ~~Duas grafias de status erram filtro por 157 linhas~~ → **afirmação
   corrigida**: nenhum filtro é afetado hoje (recorte por `tipo` na origem).
   Correção compatível preparada, não aplicada.
4. **Arquivo original de borderô não é guardado.** Decisão de produto: passar a
   guardar (o hash já é obrigatório e o bucket já existe para acordos) ou aceitar
   depender do reenvio da ULBRA.
5. **Desempenho não medido.** Se a limpeza for aprovada, medir antes/depois
   (recarga de cache de schema, `pg_dump`) para que o ganho seja número e não
   suposição.
6. **NOVO — `authenticated` pode `TRUNCATE` as 548 tabelas de lastro.**
   Independe da decisão de retenção e é a pendência mais séria aberta aqui.
