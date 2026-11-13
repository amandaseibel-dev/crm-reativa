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

**Janela de execução:** o script aborta quando a data do banco (UTC) difere da de São Paulo, o que acontece **entre 21h e 24h BRT**. Executar **entre 00:00 e 20:59 BRT**, fora do expediente (preferência: 19:00–20:59). Timeout de 300 s (`statement_timeout`) desfaz o lote inteiro sem registro por aluno.

### Concorrência: o que o script garante e o que não garante

- **Garante:** linhas do aluno e de todos os seus casos travadas antes de ler os irmãos; espera máxima de 5 s por trava (`lock_timeout`), com o aluno pulado em vez de bloquear o lote; cada aluno em subtransação; invariante por lista de ids.
- **Não garante** que um operador que acionar durante a execução não tenha a ação lida como “casos já resolvidos” pelo lote. O lote pula o aluno quando a revalidação detecta mudança; uma proteção criada em **outra tabela** (acordo, pagamento) no mesmo instante pode passar. Por isso a janela é fora do expediente.
- **Teste de interação simultânea:** não executado. A bancada roda numa única sessão; não há como provar concorrência real. Proposta: um teste com duas sessões reais, num ambiente de teste, **com autorização própria**.

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

**G2 — fora desta PR.** Receptivo (`sistema_assumir_receptivo`), movimentação da gestão (`carteira_geral_trocar_dono`) e vínculos de responsável (`vincular_responsavel_caso`, `desfazer_acao`) vão para PR separada, precedida de auditoria de cada caminho. Até lá, esses caminhos **continuam podendo mudar o responsável de irmão com fidelização vigente**: é risco residual da operação atual, não introduzido por esta PR.

**Escopo desta PR:** liberação, cron, teto e assunção de caso.

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
- Provas: `supabase/tests/fidelizacao_giro_segue_os_10_dias.test.js` (90) e `supabase/tests/fidelizacao_giro_lotes.test.js` (67)
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
- **Concorrência real** não comprovada (bancada de sessão única).
- **Papéis e RLS em produção:** o teste usa papéis simulados; `set local role authenticated` real não executado.
- **Dublês declarados da bancada:** `audit_log`, `caso_encerramento_sem_saldo`, `auth.email()`, `cron.job`.
- **Diferenças da bancada em relação à produção, declaradas em `fidelizacao_giro_lotes_prod_20261112.sql`:** `caso_encerrado_operacional` (produção delega ao corpo `_caso_encerrado_operacional_regra`, com congelamento e saldo conferido), `caso_aguarda_confirmacao_financeira`, `fn_atualizar_ultimo_acionamento`; 3 gatilhos de `casos` e 11 de `alunos` não reproduzidos. Os gatilhos que faltam disparam por STATUS, que a liberação e a restauração não escrevem.
- **Tempo de execução** de um lote em produção não medido.
- **Os números** deste documento são de 12/11/2026 e mudam todo dia; a execução usa o retrato do próprio dia.
