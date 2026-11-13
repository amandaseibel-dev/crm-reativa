# Fidelização do giro de outubro segue os 10 dias (12/11/2026)

**Status:** migration PENDENTE, nada aplicado em produção. Nenhuma liberação
executada, nenhum giro, nenhuma redistribuição.
Arquivos: `supabase/aguardando_aprovacao/20261112210000_fidelizacao_giro_segue_os_10_dias.{sql.pendente,rollback.sql}`,
teste `supabase/tests/fidelizacao_giro_segue_os_10_dias.test.js` (90 testes).
Scripts de operação em `supabase/recovery/20261112_giro_fidelizacao_0{0,1,2}_*.sql`,
teste `supabase/tests/fidelizacao_giro_lotes.test.js` (67 testes). **Sem alteração de tela** nesta PR.

## Regra definitiva (gestão, 12/11/2026)

1. Fidelização de 10 dias, inclusive para caso do giro de outubro.
2. A partir do 11º dia sem interação válida o caso perde a exclusividade.
3. Fica disponível ao receptivo e elegível às Ações Massivas, respeitando as demais proteções.
4. Sem novo giro e sem redistribuição automática.
5. Preservar acordos, atendimentos em andamento, retornos e outras proteções legítimas.
6. A marca histórica do giro não mantém fidelização indefinida.
7. "Perdendo o caso" reflete a disponibilidade real, não só dias.

## Causa (medida em PROD, 12/11, somente leitura)

`liberar_fidelizacao_caso` e `trg_impor_teto_operador` decidem pela **marca**
`casos.giro_fidelizacao_ate` (não nula = blindado), não pela **data**. As datas
venceram em 26/10 (3.645 casos) e 31/10 (215), mas a marca só sai quando o dono
muda. O cron 8 (`fidelizacao_liberar_vencidos`, 05:20 BRT) roda todo dia com
sucesso e devolve `false` para todos eles. `assumir_caso_livre` tem o defeito
oposto: marca vencida deixa outro operador tomar o caso **sem olhar os 10 dias**.

## O que a migration muda (4 funções, patch ancorado, zero DML)

| Função | Mudança |
|---|---|
| `liberar_fidelizacao_caso` | guarda do giro olha a DATA (`caso_em_giro_fidelizacao`); retorno agendado pelo operador (hoje ou futuro, origem `OPERADOR%`, como `utils/retornoOrigem.js`) preserva o caso; portão interno de gestão/cron (a função era `SECURITY DEFINER` com `EXECUTE` para `authenticated` sem conferir quem chama) |
| `trg_impor_teto_operador` | marca nua → data |
| `assumir_caso_livre` | caso de giro com dono só é assumível após os 10 dias do último acionamento |
| `casos_risco_perder` | giro vigente e retorno do operador saem do card "risco de perder" (não são risco). **Não é espelho exato do cron:** o card ainda lista caso da Carteira Geral e caso em hold de 24h, que a liberação não solta (achado do Guardião). Regra no banco (Premissa 12) |

Não muda: `caso_protegido_redistribuicao`, `caso_encerrado_operacional`,
congelamento, hold de 24h, `casos_elegiveis_liberacao_fidelizacao`,
Ações Massivas, nivelamento, cron, grants, dono,
`search_path`. O bloco final **aborta** se grant/dono/search_path mudar.
Rollback devolve os 4 corpos ao texto de produção (md5 do corpo; ACL e dono não são conferidos pelo rollback) e recusa rodar se a
função mudou. Ele **não** devolve ao operador o que a rotina já tiver soltado
(isso é DML, por lista de ids de `historico_operadores_alunos`, com autorização).

## Significado de `protegido_contra_redistribuicao`

Não existe coluna com esse nome. É a função `caso_protegido_redistribuicao(...)`,
que devolve `true` para: `nao_acionar`; jurídico/cancelado; confirmação financeira
aberta ou título em confirmação Prime; acordo `ATIVO`; baixa/link de pagamento em
trânsito; quitação com saldo zerado; e status de tratativa (acordo fechado/em
andamento, em negociação, aguardando pagamento/financeiro, proposta, termo, link
cartão, valores enviados, pago parcial, em tratativa, **retorno agendado**).
É a proteção legítima. Tudo isso continua valendo.

## Conciliação 1.529 × 1.491

São populações diferentes e ambas se mexem todo dia (medido agora: 1.612 parados
há 11+ dias ou nunca acionados, com operador):

- **1.529** ≈ nível `PERDENDO` com data (1.527 hoje) → **inclui a Carteira Geral** (121 casos).
- **1.491** ≈ parados 11+ dias **fora da Carteira Geral** (1.486 hoje) → inclui 75 casos que o nível armazenado ainda não marca como PERDENDO (recálculo só às 06:00).
- Conta: 1.612 − 126 (Carteira Geral) = 1.486; 1.527 − 121 + 75 + 5 (nunca acionados) = 1.486.
- Não consegui reproduzir os valores exatos de 1.529/1.491 porque a base muda diariamente; a diferença de 38 é explicada por essas duas fronteiras.

## Universo final (simulação em PROD, 12/11 ~14h, somente leitura)

Casos que **perderiam a exclusividade na 1ª rodada do cron 8**: **969** · saldo R$ 1.213.436.

| Operador | Liberam | Saldo (R$) |
|---|---|---|
| cobranca13 | 343 | 532.913 |
| cobranca06 | 278 | 398.176 |
| cobranca05 | 179 | 113.289 |
| cobranca12 | 162 | 160.389 |
| cobranca08 | 3 | 682 |
| cobranca11 | 3 | 7.142 |
| cobranca10 | 1 | 845 |

Garantias medidas: **0** com acionamento válido nos últimos 10 dias (por
`data_ultimo_acionamento` e por movimentação `FINALIZACAO_ATENDIMENTO` /
`ACAO_MASSIVA_EXTERNA*`); 2 nunca acionados; todos com marca de giro vencida.

Ficam de fora (e continuam com o operador), dos 4.009 casos com marca fora da Carteira Geral (1ª medição): 2.642
ainda dentro dos 10 dias e 338 protegidos; os 1.029 restantes eram os soltáveis. Na 2ª medição, já com a guarda de retorno,
esses 1.029 viraram 969 que liberam + **63 com retorno marcado pelo operador para hoje** (todos da cobranca06) +
1 no hold de 24h = 1.033; a diferença de 4 casos é a base viva entre as duas consultas (minutos), não erro de conta.

Pontos a saber:
- 966 dos retornos futuros são `AUTOMATICO` (carimbo das Ações Massivas) e **não** protegem: não são compromisso do operador.
- 14 alunos têm `status_jornada = EM_ATENDIMENTO` parado desde junho: marca velha, não é atendimento em andamento; não protegem.
- Quem tem marca e ainda está dentro dos 10 dias continua protegido; sai sozinho no 11º dia (efeito diário, sem novo giro).

## Impacto

- **Carteira:** o operador perde exclusividade, mas o caso fica **livre**, sem dono; `responsavel_atual_*` é zerado e o último acionamento é preservado. O histórico registra `FIDELIZACAO_EXPIRADA` com o responsável anterior.
- **Receptivo:** passa a poder assumir esses casos (`assumir_caso_livre`); o teto e as proteções continuam valendo. Atenção ao pico: 969 casos livres de uma vez, 4 operadores concentram 96%.
- **Ações Massivas:** já tratam `resp is null` como livre e só protegem pelos 10 dias em BRT (`acoes_massivas_fidelizacao_protege`); os 969 entram no universo `livres` sem mudança de código.
- **Reposição de carteira (job 43):** segue **pausado**; a migration não o toca. Se for religado, vai preencher as carteiras com os livres: decisão separada.
- **Card "Sem acionamento (risco de perder)":** vem de `casos_risco_perder`; deixa de contar giro vigente e retorno do operador como risco, mas **não** é a disponibilidade exata (inclui Carteira Geral e hold de 24h) — item 7 só parcialmente atendido. Hoje a RPC devolve 1.082 linhas para a gestão: **acima do corte de 1.000 da API**, e a tela chama sem paginar (achado do Guardião; falha silenciosa para a gestão). Não mexi nisso aqui; é pendência declarada.
- **Tela (selo por linha "Perdendo o caso (Nd)" e faixa de prioridade):** **não alterada**. Uma primeira versão decidia isso no `.jsx`; foi **descartada** porque (a) viola a Premissa 12 (regra no banco, não na tela) e (b) dependia da lista da RPC, que passa de 1.000 linhas. O selo por linha segue contando dias até haver, no banco, uma coluna que diga se o caso pode ser solto. Follow-up proposto, fora desta PR.

## Decisões da gestão incorporadas (resposta à 2ª auditoria do Guardião)

| Decisão | Como foi atendida | Prova |
|---|---|---|
| **N1** — guarda de irmão para TODOS os casos, com e sem giro | Regra única `public.caso_pode_soltar_com_aluno` (na migração), usada pela liberação e pelo teto. Irmão com interação válida nos últimos 10 dias, sob giro vigente, congelado ou protegido segura o aluno inteiro | 10 testes de regressão com/sem giro, incluindo a cascata de 2 dias; mutação: sem a regra, 10 testes falham |
| **N2** — teto de operador por UPDATE direto | `trg_impor_teto_operador` passou a exigir `caso_pode_soltar_com_aluno` no filtro de candidatos | 3 testes separados; mutação: sem a regra, 3 testes falham |
| **Concorrência** | `liberar_fidelizacao_caso` trava (`for update`, ordem por id) TODOS os casos do aluno antes de ler os irmãos; o lote trava as linhas do aluno antes de revalidar; `lock_timeout = 5 s` nos scripts 01 e 02 (o 00 só lê casos e escreve na tabela nova) | Estrutural: o teste de travamento não prova concorrência real. **Não comprovado em execução paralela** (ver "Não comprovado") |
| **F1** — assunção no `assumir_caso_livre` (qualquer caso, com ou sem dono) | A assunção só é permitida se `caso_pode_soltar_com_aluno` aprovar: irmão com proteção vigente segura. Antes, o cascade mudava o dono de todos os casos do aluno | 3 testes de recusa (irmão encerrado dentro dos 10 dias, congelado, Carteira Geral) e 2 de permissão; mutação derruba 3 |
| Itens baixos do Guardião | Limite de erros (>10% dos alunos tentados desfaz o lote); invariante também pega troca de dono X→Y; conferência da restauração inclui status_jornada e data_ultimo_acionamento; trava de cron falha FECHADA nos três scripts (job precisa existir pelo nome); data do banco conferida nos três | Testes próprios, cada um com nome; mutação de 11 proteções: todas detectadas |
| Fuso da suíte | Teste roda no fuso de São Paulo; antes quebrava das 21h às 24h BRT | Suíte verde em qualquer horário |

## Medições de produção (12/11/2026, somente leitura, ~15h BRT)

Muda a cada hora: a execução usa o retrato do próprio dia.

- **Cron diário hoje:** 851 casos elegíveis.
- **Retidos pela guarda de irmão:** 7 casos, **todos de giro** (7 alunos). Sem giro: 0.
- **Saem após a guarda:** 844 casos pelo cron. Desses, **63 têm retorno marcado pelo operador** (hoje ou futuro), que a liberação recusa: **781 saem de fato**, e são exatamente o universo do lote (753 alunos). Os 7 retidos por irmão seguem com o operador.
- **Universo do giro por lote (alunos liberáveis, após a guarda):** lote 1 (cobranca13) 329 alunos / 340 casos alvo; lote 2 (cobranca06) 254 / 264; lote 3 (demais) 170 / 177. **Total 753 alunos, 781 casos alvo, R$ 1.018.960.** 7 alunos ficam fora, retendo 7 casos (R$ 9.748).
- **Teto:** 9 operadores com carga; **nenhum acima do teto** hoje. O caminho do N2 existe, mas não se manifesta agora.
- **Dessincronias responsável × operador:** 0. **E-mails com maiúscula:** 0. **`status_acionamento` vazio (''):** 0 (148 nulos, tratados).
- **Casos encerrados que sairiam junto (ARRASTO):** 0 nesta medição (os 7 que apareciam antes estão congelados e viraram RETIDO).
- **Cron 8 (fidelizacao_liberar_vencidos):** ativo. **Job 43 (reposicao_carteira_minuto):** inativo.
- **Sessão do banco:** UTC. **Privilégios padrão** do schema public: concedem tudo a anon/authenticated/service_role (a tabela de backup revoga).

## Plano final de execução e reversão (NÃO AUTORIZADO)

**Situação em 12/11/2026:** a gestão aprovou a regra e a liberação em três lotes, e
pediu uma nova auditoria antes de qualquer nova aprovação. **Não está autorizado**
aplicar a migração, pausar o cron, liberar casos ou mesclar a PR.

### Ordem, travas e janela

1. **Pré-voo (leitura):** md5 das quatro funções = `de8a3b43…`, `3d01bbd1…`, `607a8b4f…`, `702279a5…`; grants = `{postgres, authenticated, service_role}`; cron 8 ativo; job 43 inativo.
2. **Pausar o cron 8** — `select cron.alter_job(8, active := false);`. A migração aborta se ele estiver ativo.
3. **Aplicar a migração** (`.sql.pendente`, em transação). O bloco final aborta se grant, dono ou search_path mudar.
4. **Backup** (`00_backup.sql`) — aborta se o cron 8 estiver ativo, se o job 43 estiver ativo ou não existir pelo nome, se a data do banco não for a de São Paulo, ou se a tabela já existir.
5. **Lote 1 (cobranca13)**, depois **lote 2 (cobranca06)**, depois **lote 3 (demais)** — `01_liberar_lote.sql` com `v_lote` trocado. Um por noite.
6. **Reativar o cron 8** — só depois do lote 3 conferido.

**Janela operacional:** ver a seção "Janela de execução". A faixa 00:00–20:59 BRT é apenas o **limite técnico** do script (fora dela a data do banco em UTC já virou), e **não** é janela operacional: ela atravessa o expediente.

### Concorrência: o que o script garante e o que não garante

- **Garante:** linhas do aluno e de todos os seus casos travadas antes de ler os irmãos; espera máxima de 5 s por trava (`lock_timeout`), com o aluno pulado em vez de bloquear o lote; cada aluno em subtransação; invariante por lista de ids.
- **Provado em Postgres real:** operador segurando a linha não derruba o lote — o aluno é pulado e registrado. **Não garante**, ainda assim, que uma ação iniciada no mesmo instante seja lida como “caso já resolvido” pelo lote. O lote pula o aluno quando a revalidação detecta mudança; uma proteção criada em **outra tabela** (acordo, pagamento) no mesmo instante pode passar. Por isso a janela é fora do expediente.
- **Teste de interação simultânea: EXECUTADO e aprovado (13/11).** Job de CI `fidelizacao do giro — concorrencia real (postgres isolado)`, com **duas sessões `psql`** num Postgres descartável (`supabase/tests/concorrencia_fidelizacao_giro/`). Resultado:

| Cenário | Resultado |
|---|---|
| Liberação simultânea do mesmo caso, duas sessões | caso solto uma vez; histórico gravado **1 vez** |
| Lote com a linha de um aluno travada por um operador | o lote **não abortou**; o aluno travado foi **pulado** pelo `lock_timeout` e ficou com o operador; os outros **11 foram liberados**; 1 erro registrado, abaixo do limite de 10% |
| Assunção simultânea do mesmo caso por dois operadores | **exatamente um** venceu; o caso ficou com um dono só |

Isso fecha o risco residual que estava declarado como "não provado em sessão única".

### Execução: conferência depois de cada lote (somente leitura)

```sql
-- 1. resultado do lote
select lote, tipo, count(*) total,
       count(*) filter (where liberado_em is not null) liberados,
       count(*) filter (where pulado_motivo is not null) pulados
  from public._backup_fidelizacao_giro_20261112 group by 1, 2 order by 1, 2;
-- 2. nenhum liberado com acionamento nos últimos 10 dias (esperado: 0). Data de São Paulo.
select count(*) from public._backup_fidelizacao_giro_20261112 b
  join public.casos c on c.id = b.caso_id
 where b.liberado_em is not null
   and c.data_ultimo_acionamento + 10 >= (now() at time zone 'America/Sao_Paulo')::date;
-- 3. nenhum liberado ganhou dono automático (esperado: só quem assumiu pela tela)
select c.operador_email, count(*) from public._backup_fidelizacao_giro_20261112 b
  join public.casos c on c.id = b.caso_id
 where b.liberado_em is not null and c.operador_email is not null group by 1;
-- 4. nenhum caso fora do backup ficou sem operador desde o início do lote (esperado: 0).
--    Trocar o instante para o início do lote; usa o horário, não caso_atualizado_por.
select count(*) from public.casos c
 where c.operador_email is null
   and c.caso_atualizado_em >= (select min(liberado_em) from public._backup_fidelizacao_giro_20261112 where lote = 1)
   and not exists (select 1 from public._backup_fidelizacao_giro_20261112 b where b.caso_id = c.id);
```

### Reversão

| Momento | O que fazer | Limite |
|---|---|---|
| Antes de qualquer lote | Rollback da migração (devolve as 4 funções e a regra de irmãos ao texto de produção, por md5); reativar o cron 8 | Nenhum dado mudou |
| Depois de um ou mais lotes | Cron 8 **continua pausado** → rollback da migração → `02_restaurar.sql` (`v_lote` = 1, 2, 3 ou 0) → conferir → reativar o cron 8 | A restauração **não devolve** aluno que mudou depois de solto (motivo `nao_restaurado_mudou_depois_da_liberacao`) nem o que já foi assumido (`nao_restaurado_ja_tem_dono`). Esses casos a gestão decide caso a caso |
| Restaurar mantendo a regra nova | Possível só com `v_exigir_regra_antiga := false` e decisão expressa. **Consequência:** o cron diário volta a soltar os casos de giro vencidos e os irmãos que a regra não permite, no dia seguinte, a menos que o cron siga pausado | Não recomendado |

A restauração devolve operador, responsável, marca do giro, retorno, hora, próxima ação, origem e confirmação do retorno, a partir do retrato tirado **no instante da liberação**. Cada aluno é independente: um que não volta fica como estava e pode ser tentado de novo depois.

**Retorno marcado pelo operador depois de solto** segura a restauração daquele aluno. **Retorno automático recalculado** (ação massiva) **não** segura: é carimbo, não compromisso. Isso é decisão de projeto e vem coberta por teste.

### Efeitos conhecidos

- Os casos liberados saem como **livres**: aparecem nas ações massivas e no receptivo, sujeitos às regras de recência e de canal.
- O cron diário mudou para todos os casos: a regra de irmãos vale também fora do giro, como decidido pela gestão. Os **7 casos retidos** de hoje são todos de giro; os demais casos do cron diário não mudam de comportamento hoje.
- Na reativação do cron 8, ele solta o que restou elegível. Os retidos por irmão **não saem na manhã seguinte**: só saem quando o irmão deixar de estar dentro dos 10 dias, sob giro, congelado ou protegido.
- O espelho `alunos_unificados` continua mostrando o operador anterior depois da liberação (comportamento já existente em toda liberação diária).

## G1 corrigido e G2 separado (decisão da gestão, 12/11/2026)

**G1 — regra final de irmãos** (`caso_pode_soltar_com_aluno`): um irmão só segura o aluno se tiver responsável **e** proteção vigente — acionado há 10 dias ou menos, giro vigente, congelado ou protegido. Estar na Carteira Geral ou em pool de ex-operador, por si só, **não** segura.

| Regra da gestão | Como ficou | Teste |
|---|---|---|
| 1. Irmão livre na Carteira Geral não bloqueia a assunção | não entra na regra sem proteção vigente | "F1 / Q3 + G1", "A2 / G1 regra 5" |
| 2. Irmão com responsável e fidelização vigente segue protegido | bloqueia cron, teto, troca de mão e assunção | "G1 regra 2" (assunção e cron) |
| 3. Pool de ex-operador só é livre sem proteção vigente | mesma checagem de proteção | "G1 regra 3" (dois testes) |
| 4. Assumir caso livre não transfere irmão protegido | a checagem vale para TODA assunção, inclusive de caso sem dono | "G1 regra 4"; mutação derruba |
| 5. Livre assunção da Carteira Geral preservada | caso da Carteira Geral sem irmão protegido é assumido | "G1 regra 5" |

**Remedição em produção (12/11 21:19 BRT, somente leitura, com a regra final):** 851 elegíveis no cron; **7 retidos, todos por irmão congelado e todos de giro**; 0 sem giro; 844 passam pela regra; lotes 329 / 254 / 170 alunos (340 / 264 / 177 casos), total **753 alunos, 781 casos, R$ 1.018.960**. Nenhum caso da Carteira Geral entre os elegíveis. Medido depois das 21h BRT, quando a data do banco (UTC) já é a do dia seguinte: remedir na janela de execução.

**H1 (6ª auditoria) — corrigido:** na troca por carteira cheia, o caso do próprio operador só é solto se estiver fora dos 10 dias e sem giro vigente (teste "H1", dois cenários).

**Decisões de regra pendentes na assunção (6ª auditoria, não tratadas):**
- **H2:** caso de pool de ex-operador acionado há 2 dias (ou congelado) é assumível "sem esperar os 10 dias" (regra de 20/10); o mesmo acionamento segura quando está no irmão. A gestão define qual vale para o próprio caso.
- **H3:** outro operador pode assumir caso de giro vencido que tem **retorno marcado pelo operador**; a liberação recusa esse mesmo caso. Em 12/11 havia 63 casos nessa situação.
- **H5/H6:** irmão da Carteira Geral acionado há 10 dias ou menos bloqueia a assunção (lido como regra 2); e irmão livre da Carteira Geral sai dela por cascata quando o aluno é assumido ou solto, sem passar pela movimentação da gestão.
- **Medições:** a remedição das 21:19 repetiu os valores das 15h e não tem saída guardada no repositório. Remedir na janela e guardar a saída.

**Retorno agendado (decisão da gestão, 13/11/2026).** Regra única `public.aluno_retorno_operador_vigente`, usada pela liberação, cron, teto, assunção (troca de mão e carteira cheia) e card de risco. Protege só enquanto: o aluno tem responsável; o retorno é de hoje ou futuro (data de São Paulo); a origem é do operador; não foi concluído; e nasceu de um **atendimento real** (`FINALIZACAO_ATENDIMENTO`) registrado pelo **responsável atual**, com a mesma data, a **no máximo 15 dias** desse atendimento. Cancelado, vencido, concluído, sem atendimento, de outro operador ou remarcado sem novo atendimento: não protege. **15 dias é parâmetro provisório, a confirmar pela gestão.** Testes: futuro, hoje, vencido, cancelado, concluído, sem atendimento, automático, troca de responsável, renovação e remarcação (ver "retorno agendado").

**Auditoria dos casos com retorno do operador (produção, 13/11/2026, somente leitura).**
- Primeira leitura (12/11 noite): 62 casos de giro elegíveis com retorno do operador para **hoje**; todos da cobranca06, responsável = operador do caso, nenhum confirmado. O último atendimento do responsável foi há 14 a 38 dias. 28 não têm nenhuma movimentação com retorno; 34 têm `FINALIZACAO_ATENDIMENTO`, mas com outra data de retorno.
- Remedição (13/11): 599 alunos com retorno do operador hoje ou futuro na base; 216 têm atendimento real do responsável com a mesma data (válidos pela regra). **Dos 61 que estão entre os elegíveis à liberação, nenhum é válido pela regra** — são retornos remarcados ou sem atendimento.
- **Consequência:** com a regra nova esses 61 **deixam de ser protegidos** e entram no universo de liberação. Antes, a regra antiga (só data e origem) os segurava. A gestão deve confirmar isso antes de qualquer execução.

**Auditoria dos retornos (13/11/2026, somente leitura) — pedida pela gestão; nada movimentado.**

*Os casos da cobranca06 com retorno do operador para hoje (62 na leitura de 13/11; eram 61 na anterior):*

| Categoria | Casos | O que se viu |
|---|---|---|
| Evidência de negociação ou compromisso | 10 | Só pelo texto da tabulação (ex.: "Aguardando confirmação de pagamento", "Enviado ao financeiro"); 2 com solicitação de confirmação de pagamento nos últimos 45 dias. Nenhum acordo ativo, nenhum link de pagamento recente |
| Apenas remarcado, sem atendimento | 0 isolados | (ver a linha seguinte: nenhuma das datas tem atendimento) |
| Possível falha de registro ou integração | 52 | A data de retorno atual **não aparece em nenhuma movimentação** (causa mais provável: a Minha Carteira não grava a data na movimentação; ver correção abaixo). Em 39 casos ela foi empurrada de 4 a 122 dias além do último retorno registrado; em 23 nunca houve retorno registrado |
| Já perderam a fidelização normal de 10 dias | **62 de 62** | Último atendimento do responsável há 14 a 38 dias |

Sinais em comum aos 62: retorno **sempre para hoje**, **sem hora marcada**, próxima ação com o texto automático e situação `COBRANCA_VENCIDA`.

**CORREÇÃO (13/11, após a 7ª auditoria do Guardião): a hipótese de "rotina automática" não se sustenta.** Todos os 62 têm atendimento real do responsável atual (`FINALIZACAO_ATENDIMENTO`), 14 a 38 dias antes do retorno; 41 têm distância de 10 a 20 dias. O que falta é o **vínculo** na movimentação: a tela **Minha Carteira grava o retorno no aluno, mas a movimentação de atendimento sai sem a data de retorno** (`PainelCarteira.jsx:2034-2036`, `:2056-2065`); só a ficha do aluno e a fila operacional gravam a data na movimentação. Medido: **92,9% das movimentações de atendimento dos últimos 60 dias (28.352 de 30.519) não têm data de retorno**, e **383 dos 599 retornos de operador** (hoje ou futuro) não têm movimentação com a mesma data. Em 31 dos 62 o último atendimento do responsável foi gravado sem data de retorno.

**Consequência para a regra:** exigir "atendimento do responsável com a mesma data de retorno" reconhece só cerca de um terço dos retornos de operador. Os outros dois terços são, em grande parte, retornos legítimos marcados pela Minha Carteira que a regra trata como inválidos. A regra, como está na branch, **não deve ir adiante sem decisão da gestão** sobre o critério de vínculo (ver as opções ao final).

*Os 216 retornos válidos pela regra (atendimento real do responsável com a mesma data), por distância entre atendimento e retorno:*

| Distância | Retornos |
|---|---|
| 0 a 7 dias | 0 |
| 8 a 10 dias | 215 |
| 11 a 15 dias | 1 (12 dias) |
| acima de 15 dias | 0 |

Desses 216, **182 vêm da tabulação `MENSAGEM_ENVIADA`** (prazo automático de 7 dias úteis), 32 de `EM_ATENDIMENTO` e 2 de `LEMBRETE_PARCELA`. **Nenhum tem hora marcada.** O limite de 15 dias muda o resultado de 1 caso; 10 dias cobririam 215 dos 216.

**Situação da regra:** o código da branch usa 15 dias como **hipótese de teste** (diretriz 5), e nada vai para produção. A regra final aguarda a gestão.

**Pendências da 7ª auditoria (retorno agendado), declaradas e não resolvidas:**
- **J1 (falso negativo):** ver a correção acima. A gestão escolhe o critério de vínculo.
- **J2:** retorno válido de **ex-operador** (pool) bloqueia assunção e liberação por até 15 dias: o caso fica preso a quem não vai ligar. Confirmar.
- **J5:** se o responsável vai de X para Y e volta para X, um atendimento antigo de X volta a valer. Borda não sondada.
- **J6:** a restauração (`02`) ainda usa a regra antiga de retorno (só origem OPERADOR) para decidir se restaura; é mais conservadora, mas diverge da regra única.
- **J3:** os números de produção desta seção (62, 28, 34, 599, 383, 216, 92,9%) vêm de consultas de leitura sem saída guardada no repositório.

## Vínculo do retorno — regra final da gestão (opção 3, 13/11/2026)

`public.aluno_retorno_operador_vigente(uuid)`, aplicada por liberação, cron, teto, assunção e card de risco (regra 7). Protege enquanto, e somente enquanto:

| Condição | Implementação |
|---|---|
| Responsável atual é operador **ativo** | ex-operador não bloqueia (regra 5) |
| Retorno de hoje ou futuro, origem do operador, não concluído | regras 1, 2 e 3 |
| Atendimento do responsável **posterior à última troca** | `m.registrado_em >= responsavel_atual_em` (regra 6: X→Y→X não revalida) |
| **Via explícita:** movimentação com a mesma data de retorno, até 15 dias do atendimento | regra 1 (15 dias = hipótese de teste, não aprovado) |
| **Via alternativa:** atendimento do responsável nos últimos 10 dias | regra 2, janela de 10 dias aprovada |
| Remarcar sem atender não renova | a alternativa conta a data do **atendimento**, não a do retorno (regra 4) |

11 testes cobrem: alternativa dentro e fora dos 10 dias, remarcação, via explícita dentro e fora dos 15 dias, ex-operador, X→Y→X nos dois sentidos, retorno concluído e atendimento de outro operador.

**Retornos humanos agendados ANTES da correção (13/11).** Até a correção, a Minha Carteira gravava o retorno no aluno e **no texto** da movimentação ("Retorno: DD/MM/AAAA"), mas não no campo de vínculo. **Ausência do campo não é prova de agendamento automático.** A regra passa a reconhecer as duas formas de vínculo — campo e texto —, com o mesmo teto de 15 dias e as mesmas exigências (responsável atual, atendimento posterior à última troca, retorno não concluído). Quatro testes cobrem o estoque antigo. **Quantidade em produção: pendente de medição** (a leitura caiu com erro do conector; medir antes da execução).

**Correção da origem dos dados:** `PainelCarteira.jsx` passa a gravar `data_retorno` na movimentação de atendimento, nos dois pontos que registram retorno (ação rápida e tabulação). Antes, só a ficha do aluno e a fila operacional gravavam, e era essa a causa dos retornos sem vínculo. Consistência com os outros dois caminhos: mesma data que vai para `alunos.data_retorno`, às 12:00 em São Paulo, para o dia não mudar na conversão de fuso.

### ACHADO: a via alternativa de 10 dias é redundante no fluxo normal

`FINALIZACAO_ATENDIMENTO` conta como acionamento (`eh_tipo_acionamento`), e o gatilho `fn_atualizar_ultimo_acionamento` reinicia a fidelização de 10 dias. Então **um atendimento nos últimos 10 dias já protege o caso pela fidelização normal**, antes de qualquer regra de retorno: o caso nem chega a ser elegível ao cron. Provado em bancada (teste "ACHADO").

**Consequência:** a via alternativa só muda o resultado quando o último acionamento está **dessincronizado** do atendimento. Os 62 casos auditados têm último atendimento do responsável há **14 a 38 dias** — nenhum nos últimos 10. Pela leitura de 13/11, **a alternativa de 10 dias não devolve proteção a nenhum deles**; quem pode devolver é a via explícita (até 15 dias), e só para os que tiverem a data gravada na movimentação. Isso **precisa ser remedido** (ver abaixo) e pode exigir nova decisão da gestão sobre a janela.

### Janela da via alternativa — decisão da gestão (13/11)

Mantida **provisoriamente em 10 dias**, sem ampliar. A regra não deve ser alterada de novo antes da auditoria. A via explícita segue com 15 dias, também provisória.

### Auditoria EXECUTADA em produção (13/11/2026, 09:04 BRT, somente leitura)

Consulta versionada em **`supabase/audits/retorno_vinculo_auditoria_20261113.sql`**, rodada tal como está, em janela de baixo tráfego (2 consultas ativas no banco). **Saída guardada em `supabase/audits/retorno_vinculo_auditoria_20261113_RESULTADO.md`.**

O teste de equivalência da suíte prova a concordância com `aluno_retorno_operador_vigente` em dois níveis, sobre 4 cenários (explícita, alternativa, sem proteção, ex-operador): **caso a caso**, reusando as mesmas CTEs do arquivo versionado e comparando a via de cada aluno com a função; e no **agregado**, rodando o arquivo inteiro e conferindo a cardinalidade de cada balde.

**Separação das três proteções, sem dupla contagem** (pergunta 7):

| Proteção | Casos |
|---|---|
| Fidelização normal de 10 dias | **4.839** de 6.183 casos com operador e não encerrados |
| Giro vigente | 0 (todas as marcas já venceram) |
| Via **explícita**, em caso que a fidelização normal não protege | **0** |
| Via **alternativa**, em caso que a fidelização normal não protege | **0** |
| Sem proteção nenhuma (elegíveis ao cron) | **850** |

**Respostas às 6 perguntas:**

1. **Dessincronização:** **0** casos elegíveis têm atendimento do responsável nos últimos 10 dias. Não há dessincronização entre atendimento e último acionamento.
2. **Protegidos exclusivamente pela via alternativa: 0.**
3. **Dos 600 retornos de operador vigentes na base:** 217 com vínculo explícito válido, 177 sem explícito mas cobertos pela alternativa, 206 sem nenhuma via (11 deles com responsável inativo). **Nenhum desses 394 protegidos está entre os casos elegíveis** — todos já estão protegidos pela fidelização normal.
4. **Dos 62 casos antes auditados: 0 ganham proteção** pela regra final. Seguem sem proteção.
5. **Proteção extra da via explícita entre o 11º e o 15º dia: 0 casos.**
6. Sem casos na faixa, não há tabulação a classificar.

### Decisão da gestão (13/11): a via alternativa FICA nesta entrega

A medição mostrou que, hoje, a via alternativa não protege exclusivamente nenhum caso (0 de 850) e que a dessincronização que a justificaria é zero — ela é redundante enquanto todo atendimento reiniciar a fidelização de 10 dias. **A gestão decidiu mantê-la nesta entrega**, e a regra não foi alterada. Fica registrado que a sua remoção, se e quando a gestão quiser, não tem efeito sobre o universo medido.


### Achados da 8ª auditoria do Guardião — tratados e declarados

| Achado | Situação |
|---|---|
| **K1** — o roteiro afirmava "caso a caso" e o teste só comparava contagens | **Corrigido**: o teste passou a 4 cenários, com asserção da via de cada aluno (explícita × alternativa) além do agregado |
| **K6** — o revoke não cobria `service_role` | **Corrigido e medido**: em produção os privilégios padrão do schema `public` concedem `EXECUTE` a `service_role`; as duas funções novas passaram a revogar dele também. São predicados internos, chamados só de dentro de funções `SECURITY DEFINER` (dono `postgres`), então revogar não quebra a tela — ao contrário do caso de RPC chamada pelo front |
| **K2** — o teto de 15 dias da via explícita passa a mandar | **Declarado**: retorno marcado para mais de 15 dias depois do atendimento perde a proteção no 11º dia, mesmo nascido em atendimento real. Hoje o efeito é nulo (0 casos na faixa), mas a correção da Minha Carteira muda a distribuição. Os dois parâmetros (15 e 10) seguem provisórios |
| **K3** — recarimbar `responsavel_atual_em` derruba a proteção na hora | **Declarado**: é consequência querida da regra 6 (X→Y→X não revalida), mas qualquer rotina que recarimbe sem trocar o dono tem o mesmo efeito. Os caminhos que fazem isso estão em G2, fora desta PR |
| **K5** — aluno e movimentação são duas requisições sem transação | **Declarado**: se a segunda falhar, o retorno fica sem vínculo até o próximo atendimento. Comportamento pré-existente da tela, não introduzido aqui |
| **K7** — a movimentação não registra a origem do retorno | **Declarado**: um atendimento cujo prazo foi automático pode servir de vínculo para um retorno de operador posto depois na mesma data. Fica dentro da regra 5 (atendimento real do responsável), mas não é exatamente o compromisso que a data representa |
| **K8** — responsável inativo perde todos os compromissos de uma vez | **Declarado**: é a decisão da gestão sobre pool livre (regra 5). Medido: 11 dos 600 retornos vigentes estão nessa situação |
| **K4** — a consulta duplica o predicado da regra | **Parcialmente tratado**: a duplicação é necessária enquanto a função não existe em produção; a amarra é o teste de equivalência, agora mais forte. A saída da execução passou a ser versionada |
| Teto (caminho) | O Guardião não conseguiu provar por sonda; confere por leitura e pela suíte |


**G2 — fora desta PR.** Receptivo (`sistema_assumir_receptivo`), movimentação da gestão (`carteira_geral_trocar_dono`) e vínculos de responsável (`vincular_responsavel_caso`, `desfazer_acao`) vão para PR separada, precedida de auditoria de cada caminho. Até lá, esses caminhos **continuam podendo mudar o responsável de irmão com fidelização vigente**: é risco residual da operação atual, não introduzido por esta PR.

**Escopo desta PR:** liberação, cron, teto e assunção de caso.

## Janela de execução (corrigida em 13/11, após observação da gestão)

A faixa **00:00–20:59 BRT é o limite TÉCNICO** do script: a partir das 21:00 a data do
banco (UTC) já é a do dia seguinte e os três scripts abortam. **Isso não é uma janela
operacional** — ela atravessa o expediente inteiro, e liberar lotes com a equipe
atendendo é justamente o que aumenta os alunos pulados e o risco de leitura
desatualizada.

**Janela operacional, dentro do limite técnico e fora do atendimento:**

| Opção | Faixa BRT | Observação |
|---|---|---|
| **Preferencial** | **19:00 – 20:30** | Depois do atendimento e com folga até o corte técnico das 20:59 |
| Alternativa | 00:00 – 06:30 | Madrugada, antes do expediente |

Cada lote em uma noite, com conferência na manhã seguinte: **três noites**. O cron
`fidelizacao_liberar_vencidos` fica pausado entre o primeiro lote e a reativação final.

Se a gestão confirmar outro horário de encerramento do atendimento, a faixa muda junto
— o que não muda é a regra: **nenhum lote durante o atendimento da equipe**.

## MEDIÇÃO ATUAL — 13/11/2026, 13:37 BRT (somente leitura, consulta versionada)

Executada com `supabase/audits/retorno_estoque_antigo_20261113.sql`, em janela de baixo tráfego (2 consultas ativas). **Substitui todos os números anteriores deste documento**, que são históricos.

| Item | Valor |
|---|---|
| Casos elegíveis à liberação | **575 casos / 558 alunos** (remedido às 15:31: **565 / 548**) |
| Alunos | **558** |
| Valor em aberto | **R$ 893.385** |
| Com retorno de operador vigente | 59 |
| Protegidos pelo vínculo no campo (formato novo) | 0 |
| **Recuperados pelo vínculo no texto** (estoque antigo) | **0** |
| Protegidos só pela janela de 10 dias | 0 |
| **AMBÍGUOS — retidos, fora da liberação** | **57 casos** (remedido às 15:31: **56 casos / 55 alunos**) |
| **LIBERÁVEIS** | **518** |

**Leitura (corrigida em 13/11).** A correção do vínculo por texto **não recuperou nenhum caso**: em 57 dos 59 casos com retorno vigente, o atendimento do responsável cita **outra** data, e não a data que está hoje no aluno.

A conclusão anterior deste roteiro — "o retorno foi remarcado depois do atendimento, sem novo atendimento" — **estava errada e foi retirada**. A divergência entre a data do texto e a data vigente não prova remarcação humana.

Medição versionada, 13/11 **15:31**, em `supabase/audits/retorno_ambiguo_origem_20261113.sql` (saída em `..._RESULTADO.md`):

| Sinal | Resultado |
|---|---|
| Ambíguos | **56 casos / 55 alunos** |
| Retidos por "texto cita outra data" | 56 · por "sem atendimento do responsável": 0 |
| `data_retorno` = **hoje** | 56 de 56 · no futuro: 0 |
| Texto do atendimento cita data **já vencida** | 56 de 56 |

**O que isto prova:** nenhum tem data futura, todos têm a data vigente igual ao dia da medição, e em todos o texto do próprio responsável aponta data anterior já vencida.

**O que NÃO prova:** quem gravou a data. O conjunto é **compatível** com o recálculo automático investigado na [#949](https://github.com/ReATIVA/crm-reativa-atual/pull/949), que reescreve `data_retorno` para o dia corrente — mas compatibilidade não é causa, e não há grupo de controle de retornos sabidamente humanos. **Origem não comprovada.**

**Um sinal que eu citei antes não existe:** `alunos.data_retorno` é do tipo `date` e nunca guardou hora. A frase "agendamento humano deixa hora, e nenhum destes tem" era vazia por construção; foi retirada do pacote. Conferido no catálogo de produção em 13/11.

Por isso os ambíguos **não são liberados**: a origem da data vigente não está estabelecida, e liberar sem isso arrisca tirar do operador um compromisso real. Ficam retidos com o motivo `retorno_ambiguo_decisao_pendente`, para decisão da gestão depois que a #949 fechar.

**Correção aplicada junto (achado N1 da 10ª auditoria):** a consulta afirmava que os ambíguos ficavam fora da liberação, mas os scripts **não os excluíam** — eles entrariam no backup e seriam soltos pelo lote. O backup passou a retê-los. Dois testes cobrem os dois sinais de ambiguidade, e a mutação (retirar a retenção) derruba ambos.

## ESTADO DE PRODUÇÃO CONFERIDO POR LEITURA — 13/11/2026 15:30

Medido pela via escopada em produção (`ahattpqrjmhkzsmnbdzs`), **somente leitura, zero DML**:

| O que | Estado medido |
|---|---|
| Papel da sessão que vai executar | `postgres`, **não superusuário**, sessão **não** é read-only — ou seja, esta via escreve; é por isso que as travas dos scripts existem |
| Cron 8 `fidelizacao_liberar_vencidos` | **ATIVO** — tem de ser pausado antes da migration (que aborta sozinha se não for) |
| Job 43 `reposicao_carteira_minuto` | inativo, como o roteiro exige |
| Cron 48 `nivelamento_automatico_gestao` | **ATIVO** — segue fora desta PR (G2); risco residual já declarado |
| As 4 funções alvo | dono `postgres`, `SECURITY DEFINER`, `search_path` conforme o esperado, ACL `postgres/authenticated/service_role` (sem `anon`) |
| As 3 funções novas | **não existem ainda** em produção |

## PRIMEIRO LOTE — tamanho, critérios de parada e conferência

**Tamanho.** O lote 1 é a carteira da **cobranca13**. No retrato do giro são **329 alunos / 340 casos**; no retrato de 13/11 13:37 o universo total elegível caiu para 575 casos (518 liberáveis, 57 retidos por ambiguidade). **O número definitivo do lote 1 só existe depois do backup**, que é quem classifica ALVO / ARRASTO / RETIDO na hora. O backup imprime esse número antes de qualquer liberação: é ele que você aprova, não a estimativa.

**Ordem:** lote 1 (cobranca13) → conferir → lote 2 (cobranca06) → conferir → lote 3 (demais). Um lote por noite, fora do atendimento.

**Critérios de parada — qualquer um interrompe e nada mais é liberado:**

| Gatilho | O que acontece |
|---|---|
| Backup mostra número muito acima do retrato (> 450 casos no lote 1) | Para antes de soltar. O universo mudou; remedir |
| Mais de **10%** de erro nas unidades do lote | O script aborta sozinho e não solta o restante |
| Invariante falha (caso solto fora da lista, liberado ainda com dono, livre que ganhou dono, troca X→Y) | O script aborta a transação inteira: nada sai |
| Cron 8 ativo, job 43 ativo, lote fora de ordem, lote repetido, backup ausente | Aborta antes de tocar em qualquer caso |
| Banco reiniciar ou `lock_timeout` (5 s) estourar | Transação cai inteira; nenhum caso parcialmente solto |
| Operador relatar perda de caso que ele atendeu | Para e restaura pelo `02_restaurar.sql` antes do lote seguinte |

**Conferência depois de cada lote, antes de liberar o próximo:**

1. contagem de soltos = contagem de ALVO do backup, por lote;
2. nenhum caso fora da lista do backup mudou de dono (invariante por id, já no script);
3. retidos conferem por motivo, inclusive `retorno_ambiguo_decisao_pendente`;
4. na manhã seguinte: o cron 8 segue pausado, nenhum operador acima do teto, e a fila do receptivo mostra os casos como livres;
5. ouvir a equipe na primeira hora de atendimento — relato de perda indevida é critério de parada, acima.

**Restauração.** `02_restaurar.sql` devolve por aluno, com subtransação, e recusa devolver caso que já ganhou outro dono ou que mudou depois da liberação; exige a regra antiga de volta e o cron pausado.

## PACOTE FINAL — o que está pronto e o que depende da gestão

**Pronto, nesta branch, sem nada aplicado em produção:**

| Item | Onde |
|---|---|
| Migration pendente + rollback (7 funções: 4 alteradas, 3 novas) | `supabase/aguardando_aprovacao/20261112210000_*` |
| Scripts de execução: backup, liberação por lote, restauração | `supabase/recovery/20261112_giro_fidelizacao_0{0,1,2}_*.sql` |
| Correção da Minha Carteira (grava a data do retorno na movimentação) | `src/components/PainelCarteira.jsx` |
| Provas em bancada | 181 testes (111 migração + 70 lotes) |
| Prova de concorrência real, duas sessões, Postgres descartável | job de CI `fidelizacao do giro — concorrencia real` |
| Auditoria de produção, somente leitura, com saída versionada | `supabase/audits/retorno_vinculo_auditoria_20261113*` |
| Parecer do Guardião | 11ª rodada sobre o commit final (L1/L2 fechados; os quatro itens da 11ª corrigidos neste commit) |
| **L3 — agora medido, não declarado** | Leitura de produção em 13/11 15:30: `pg_default_acl` de funções em `public` tem **duas** entradas — concedente `supabase_admin` dá EXECUTE a `postgres, anon, authenticated, service_role`; concedente `postgres` dá a `postgres, authenticated, service_role`. É por isso que o `REVOKE` explícito das funções novas é necessário, e o guard de ACL cobre as três |

**Depende só de você — uma única aprovação de implantação.** Autorizando, executo na ordem abaixo, que já está detalhada neste roteiro:

1. pausar o cron `fidelizacao_liberar_vencidos`;
2. aplicar a migration (ela aborta sozinha se o cron estiver ativo);
3. rodar o backup;
4. liberar o lote 1, conferir; lote 2, conferir; lote 3, conferir;
5. reativar o cron.

**Janela operacional:** ver a seção "Janela de execução". A faixa 00:00–20:59 BRT é apenas o **limite técnico** do script (fora dela a data do banco em UTC já virou), e **não** é janela operacional: ela atravessa o expediente.

**Números a remedir no momento da execução** (o universo muda a cada hora; os de 13/11 09:04 estão em `supabase/audits/..._RESULTADO.md`).

**Fora deste pacote, por decisão sua:** os caminhos do G2 (receptivo, movimentação da gestão, vínculos de responsável) e o nivelamento das 09:20, que seguem podendo mover irmão protegido e vão para PR separada.

## Riscos residuais (declarados)

0. **Decisões pendentes da gestão (não tratadas nesta PR):**
   - **Cron de nivelamento (09:20, `nivelamento_automatico_gestao`):** move casos por UPDATE direto e **não aplica a regra de irmãos**; o cascade leva os irmãos. Não medido quantos casos seriam afetados hoje. É redistribuição automática já existente: a gestão precisa decidir se entra nesta PR ou vira pendência separada.
   - **Cascata sem registro no cron e no teto:** `liberar_fidelizacao_caso` grava histórico só para o caso liberado; os irmãos que saem junto não ganham linha de histórico fora do lote. Rastreabilidade incompleta, não erro de dono.
   - **Teto sem travamento:** o teto lê os irmãos sem travar as linhas (não declarado antes). Custo do `EXISTS` não medido (roda só quando o teto dispara; hoje nenhum operador passa do teto).


1. **Concorrência real** não comprovada em execução paralela (ver acima).
2. **Proteção criada em outra tabela** durante a execução pode passar pela revalidação.
3. **Cron 8 pausado** deixa de soltar casos vencidos por todo o intervalo entre os lotes.
4. **Caso de giro com irmão fora da regra** segura o aluno inteiro: o caso fica com o operador mesmo vencido, até o irmão deixar de estar fora da regra.
5. **Tabela de backup** contém `aluno_id`, saldo e status. Descarte em 30 dias após o último lote, com autorização.
6. **Gate de segurança do repositório** não executado (ver abaixo).

## Arquivos

- `supabase/aguardando_aprovacao/20261112210000_fidelizacao_giro_segue_os_10_dias.sql.pendente` + `.rollback.sql`
- `supabase/recovery/20261112_giro_fidelizacao_00_backup.sql`
- `supabase/recovery/20261112_giro_fidelizacao_01_liberar_lote.sql`
- `supabase/recovery/20261112_giro_fidelizacao_02_restaurar.sql`
- Provas: `supabase/tests/fidelizacao_giro_segue_os_10_dias.test.js` (102) e `supabase/tests/fidelizacao_giro_lotes.test.js` (67)
- Fixtures: `supabase/tests/fixtures/fidelizacao_giro_*_prod_20261112.{sql,md5.json}`

## Gate de segurança e CI

- **CI da PR #936:** 24 checks verdes, 2 ignorados (regras de publicação da TV, sem relação). Inclui "testes, build e catracas". Este CI é de antes das mudanças desta rodada: **repetir**.
- **Gate do repositório (`run_security_gate.sh`):** não roda nesta máquina (sem `psql`). Consulta equivalente executada por leitura em produção, critérios que bloqueiam:
  - **Reprova produção hoje** por achados antigos, sem relação com esta PR: bucket `tv-imagens` público, `_tmp_fila2` sem RLS e 5 views (`vw_extracao_calibragem`, `vw_extracao_observabilidade`, `vw_extracao_validacao_trilha`, `vw_pagamento_suspeita_pendente`, `vw_titulo_presenca_historico`). Não conferido se são exceções já aceitas.
  - **Esta PR não acrescenta achado:** as funções são `SECURITY DEFINER` com `search_path` fixo e sem `EXECUTE` para `anon`/`PUBLIC`; a tabela de backup nasce com RLS e sem grant (inclui `TRUNCATE`); a regra de irmãos é revogada de `PUBLIC`, `anon` e `authenticated`.
  - Critérios de alerta (policies amplas, etc.) não executados.
- Checagens de código: sem `service_role` no cliente, sem segredo hardcoded, sem referência a staging. ✔

## Medições sem prova no repositório

Nenhuma destas medições está reproduzida por consulta versionada no repositório: foram feitas pelo autor, em 12/11/2026, com consultas de leitura em produção (não guardadas). **O Guardião não as conferiu.** Reconferir, com as mesmas consultas, antes de qualquer execução:

- cron diário: 851 elegíveis; 7 retidos por irmão (todos de giro); 844 pelo cron; 63 com retorno do operador; 781 saem;
- universo do giro: 329 / 254 / 170 alunos nos lotes 1 / 2 / 3; 753 alunos; 781 casos alvo; R$ 1.018.960;
- teto: 9 operadores com carga; nenhum acima do teto;
- sem dessincronia responsável × operador; sem e-mail com maiúscula; 0 `status_acionamento` vazio (148 nulos);
- cron 8 ativo; job 43 inativo; sessão do banco em UTC; privilégios padrão concedem tudo a anon/authenticated/service_role.

## Não comprovado

- **Nada foi executado em produção.** Migração, scripts e restauração rodam apenas em PGlite, na bancada.
- ~~Concorrência real não comprovada~~ — **provada em 13/11** por job de CI com duas sessões (ver acima). Permanece o limite: proteção criada em **outra tabela** no mesmo instante (acordo, pagamento) não é travada.
- **Papéis e RLS em produção:** o teste usa papéis simulados; `set local role authenticated` real não executado.
- **Dublês declarados da bancada:** `audit_log`, `caso_encerramento_sem_saldo`, `auth.email()`, `cron.job`.
- **Diferenças da bancada em relação à produção, declaradas em `fidelizacao_giro_lotes_prod_20261112.sql`:** `caso_encerrado_operacional` (produção delega ao corpo `_caso_encerrado_operacional_regra`, com congelamento e saldo conferido), `caso_aguarda_confirmacao_financeira`, `fn_atualizar_ultimo_acionamento`; 3 gatilhos de `casos` e 11 de `alunos` não reproduzidos. Os gatilhos que faltam disparam por STATUS, que a liberação e a restauração não escrevem.
- **Tempo de execução** de um lote em produção não medido.
- **Os números** deste documento são de 12/11/2026 e mudam todo dia; a execução usa o retrato do próprio dia.
