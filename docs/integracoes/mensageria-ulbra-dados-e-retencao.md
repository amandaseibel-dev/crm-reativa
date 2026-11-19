# Mensageria ULBRA — o que é armazenado, tamanho medido e proposta de retenção

Medição em produção (`ahattpqrjmhkzsmnbdzs`), 11/11/2026, somente leitura, **antes do primeiro lote de novembro**. Zero chamadas à ULBRA.

## 1. Exatamente o que é gravado (por tabela)

| Tabela | O que guarda (texto incluído) | O que NÃO guarda |
| --- | --- | --- |
| `ulbra_conversas` | id da conversa e do cliente na Mensageria, **nome do cliente como a Mensageria informa**, canal, situação, equipe (só `Reativa`), nome do atendente da Mensageria, data da última mensagem, **quem** mandou (cliente/operador/bot/sistema), **trecho da última mensagem** (`ultima_mensagem_previa`, medido: média 82, máx. 99 caracteres), data da última mensagem do cliente, `aluno_id` e `aluno_status` (identidade só por vínculo `alta_cpf`), `criado_em`/`atualizado_em` | telefone, e-mail, CPF, o histórico de mensagens (só o trecho da última), anexos |
| `ulbra_atendimentos` | id do atendimento e do cliente, nome do cliente, equipe, situação, coluna do kanban, data de entrada, identidade (`aluno_id`/`aluno_status`), destino sugerido e motivo, responsável/assumido/dispensado (e-mails internos), datas | contatos, mensagens |
| `ulbra_detalhe_fila` | ids de conversa/cliente a reler, tentativas, ponto de retomada — transitório (sai ao concluir) | — |
| `ulbra_detalhe_pendencias` | ids, motivo da pendência, datas, quem recuperou | — |
| `ulbra_leitura_usuario` | e-mail interno do usuário, id da conversa, "lido até" | — |
| `ulbra_sync_estado` | 1 linha: cursores, contadores do dia, saldo da API, campanha (após 20261111130000) | — |
| `ulbra_vinculos` | aluno ↔ cliente da Mensageria, confiança (`alta_cpf`/`alta`/`reconfirmar`), origem, quem vinculou, datas; **`telefone_e164` preenchido em 346 de 357 linhas** (gravado pela `ulbra-consultar` na criação do vínculo) | CPF |
| `auditoria` (ações `ULBRA_*`) | usuário, ação, `aluno_id`, e em `detalhes`: **quais chaves** casaram (`chaves`), resultado, confiança, origem, `ulbra_cliente_id`, flags (`telefone_concordou`, `telefone_fora_do_escopo`, `em_atendimento`), HTTP | o valor do telefone ou do CPF (a função grava só *qual* chave casou) |

Nada de conteúdo de conversa é copiado em massa: a coleta grava o trecho que `listar_conversas` devolve; `ler_conversa` (detalhe) só serve para achar a data da última mensagem do cliente e **não grava o texto** das mensagens.

**Ponto de atenção (dado pessoal):** o único telefone armazenado na integração está em `ulbra_vinculos.telefone_e164`. Não é gravado pela coleta; vem da consulta pela ficha. A proposta de retenção abaixo trata dele.

## 2. LINHA DE BASE — tamanho medido antes do primeiro lote (11/11/2026, 11:54 UTC)

Esta medição é a **linha de base**. A comparação é obrigatória depois do lote de 12/11 (mesmas consultas, registradas aqui, na seção 2.1).

| Tabela | linhas | tamanho total (índices incl.) | heap | média por linha |
| --- | ---: | ---: | ---: | ---: |
| `ulbra_conversas` | 7 | 80 KB | 8 KB | 289 B |
| `ulbra_atendimentos` | 7 | 64 KB | 8 KB | 171 B |
| `ulbra_detalhe_fila` | 4 | 48 KB | 8 KB | — |
| `ulbra_detalhe_pendencias` | 0 | 16 KB | 0 | — |
| `ulbra_leitura_usuario` | 3 | 32 KB | 8 KB | 95 B |
| `ulbra_sync_estado` | 1 | 32 KB | 8 KB | — |
| `ulbra_vinculos` | 357 | 344 KB | 152 KB | 153 B |
| `auditoria` (toda) / só `ULBRA_*` | 10.265 / 418 | 8,3 MB / ~150 KB | — | 366 B (ULBRA) |

Os tamanhos "totais" de tabelas pequenas são dominados por páginas fixas de índice (8 KB cada): o número útil para projeção é a média por linha.

### 2.1 Comparação depois do primeiro lote (preencher em 12/11)

| Tabela | linhas antes | linhas depois | novas | atualizadas | bytes antes | bytes depois |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `ulbra_conversas` | 7 | | | | 81.920 | |
| `ulbra_atendimentos` | 7 | | | | 65.536 | |
| `ulbra_leitura_usuario` | 3 | | | | 32.768 | |
| `ulbra_detalhe_fila` | 4 | | | | 49.152 | |
| `ulbra_vinculos` | 357 | | 0 (esperado) | 0 (esperado) | 352.256 | |

### Como medir depois do primeiro lote (entra no roteiro da janela de 12/11)
Anotar `T0` = instante da primeira execução. Depois do lote:
```sql
-- novos x atualizados pela coleta (a coleta NÃO cria vínculos nem auditoria)
select 'conversas' t, count(*) filter (where criado_em >= :T0) novos, count(*) filter (where criado_em < :T0 and atualizado_em >= :T0) atualizados from public.ulbra_conversas
union all
select 'atendimentos', count(*) filter (where criado_em >= :T0), count(*) filter (where criado_em < :T0 and atualizado_em >= :T0) from public.ulbra_atendimentos;
-- tamanhos (mesma consulta da medição "antes")
select table_name, pg_total_relation_size('public.'||table_name) bytes_total, pg_relation_size('public.'||table_name) bytes_heap
  from information_schema.tables where table_schema='public' and table_name like 'ulbra%' order by 1;
```
Esperado para o lote de novembro (equipe Reativa, ativas, 01→12/11): **≈ 80 conversas novas (±50%)**, poucas atualizadas (as 7 já espelhadas), atendimentos em espera da Reativa (dezenas), **0 vínculos novos**, **0 auditoria** pela coleta. Em bytes: ≈ 80 × ~600 B (linha + índices) ≈ **50 KB**.

## 3. Estimativa de crescimento mensal

Premissas: ~160 conversas ativas/dia na caixa (todas as equipes, medido em 08/11), ~5% da Reativa; a coleta grava **uma linha por conversa** e a atualiza no lugar (upsert) — o tamanho cresce por conversa distinta, não por mensagem.

| Origem | por mês | tamanho |
| --- | ---: | ---: |
| `ulbra_conversas` (Reativa, com coleta regular) | 150–300 conversas | 0,1–0,2 MB |
| `ulbra_atendimentos` | dezenas | < 0,05 MB |
| `ulbra_leitura_usuario` (usuários × conversas lidas) | até ~1.000 | ~0,1 MB |
| `ulbra_vinculos` (criados pela ficha: 216 em 09/11, 104 em 10/11) | 2.000–4.000 | 0,5–1,0 MB (índices incl.) |
| `auditoria` `ULBRA_*` (consultas e vínculos pela ficha) | 2.000–5.000 | 0,8–1,8 MB |
| **Total** | | **≈ 2–3 MB/mês** |

Conclusão: o volume é pequeno; a retenção é questão de **minimização de dado pessoal e de clareza operacional**, não de espaço. Com as fichas sob demanda (#904) o crescimento de vínculos/auditoria tende a cair.

## 4. Proposta de retenção (PROPOSTA — não autorizada; nenhuma exclusão nem eliminação de campo foi aprovada)

**Termo corrigido:** retirar `telefone_e164` é **eliminação desse campo** na linha do vínculo, não anonimização do registro — o registro continua identificando aluno ↔ cliente da Mensageria.

| Dado | Retenção proposta | Por quê |
| --- | --- | --- |
| `ulbra_conversas` com CPF confirmado | **12 meses** após `ultima_mensagem_em`; depois apagar | espelho operacional, re-coletável; 12 meses cobre o ciclo de cobrança do ano letivo |
| `ulbra_conversas` **sem CPF confirmado** (`nao_confirmado`) | **90 dias** após `ultima_mensagem_em` | nome e trecho de pessoa que pode não ser aluno: minimização (LGPD) |
| `ulbra_atendimentos` | **12 meses** após `atualizado_em` (encerrados); abertos permanecem | mesmo critério |
| `ulbra_leitura_usuario` | junto com a conversa | não faz sentido sem ela |
| `ulbra_detalhe_fila` | transitório (já sai ao concluir) | — |
| `ulbra_detalhe_pendencias` | **90 dias** após `recuperada_em`; abertas permanecem | registro operacional de pendência |
| `ulbra_vinculos` | **permanente** (nunca apagar linhas); proposta separada: **eliminar o campo `telefone_e164`** 12 meses após `desvinculado_em` e avaliar não gravá-lo nos vínculos novos | ver justificativa 4.1 |
| `auditoria` `ULBRA_*` | **5 anos**, como o restante da `auditoria` (hoje sem política: 10.265 linhas desde 07/07/2026) | ver justificativa 4.2 |
| `ulbra_vinculos_backup_20261104` (0 linhas) e `ulbra_vinculos_estrutura_backup_20261104` (15 linhas) | apagar após **90 dias** da migration (a partir de 04/02/2027), com registro no ledger | backups de migração já conferida |

**Como aplicar (próxima etapa, migration própria):** função `ulbra_retencao_aplicar()` (security definer, só `service_role`/gestão) que apaga/anonimiza pelos prazos acima e grava uma linha de auditoria com as contagens; execução **manual mensal pela gestão** (cron continua 0). Antes de apagar conversas, conferir que nenhuma pendência aberta aponta para elas.

Fora do escopo: dados do WhatsApp próprio do ReATIVA e tabelas financeiras (retenção própria).

### 4.1 Por que vínculos permanentes
- O vínculo é a **única prova de identidade** entre um aluno do ReATIVA e um cliente da Mensageria: toda linha de conversa/atendimento identifica o aluno por ele, no momento da consulta (gatilhos de identidade). Apagar um vínculo revogado faria o histórico de conversas perder a explicação de por que foi identificado, e o gatilho `trg_ulbra_vinculo_protege_historico` **proíbe DELETE e reabertura** justamente para que a revogação seja histórico, não apagamento.
- Dependências medidas: `ulbra_vinculos` é lida por `_ulbra_identidade_conversa`, `_ulbra_identidade_atendimento`, `ulbra_central_operador`, `ulbra_avisos_operador` e pela `ulbra-consultar`/`ulbra-atendimento` (Edge). Nenhuma FK aponta **para** ela (ela aponta para `alunos`, sem cascata).
- O que é dado pessoal ali é só `telefone_e164` (346 de 357 linhas). Por isso a proposta separa: **linha permanente; campo de telefone com prazo**. Cada linha custa 153 B — o custo de guardar é irrelevante; o motivo de guardar é prova.

### 4.2 Por que auditoria por cinco anos
- `auditoria` registra quem consultou a Mensageria e quem criou/bloqueou vínculo (sem valores de contato). É a trilha para responder "quem acessou o quê" — exigência de accountability da LGPD (art. 6º, X) e de defesa em eventual questionamento. Cinco anos acompanha o prazo prescricional geral do Código Civil (art. 206, §5º, I, para cobranças) e o prazo que a própria operação de cobrança usa para contratos/títulos; é a prática mais comum para trilha de auditoria de acesso. **A tabela hoje não tem política de retenção** (dados desde 07/07/2026; 8,3 MB; 2 policies; nenhuma FK). Qualquer prazo diferente é decisão da gestão/jurídico; este é o ponto de partida proposto.

### 4.3 Dependências conferidas antes de propor limpeza (11/11/2026)
- FKs **com cascata** para `ulbra_conversas`: `ulbra_detalhe_fila`, `ulbra_detalhe_pendencias`, `ulbra_leitura_usuario` (ON DELETE CASCADE) — apagar uma conversa apaga essas linhas junto; é o esperado.
- Funções que leem as tabelas: `ulbra_central_operador`, `ulbra_avisos_operador`, `ulbra_painel_gestao`, `ulbra_conversa_marcar_lida`, `ulbra_atendimento_assumir/dispensar`, `ulbra_sync_gravar`, os três gatilhos de identidade — nenhuma depende de linha antiga para funcionar; só refletem o que existe.
- **View `efetividade_caixa_origem` cita `ulbra_`**: precisa ser lida antes de qualquer expurgo — se ela conta conversas/vínculos, apagar linhas muda um indicador de efetividade. Pendência de conferência.
- Policies: leitura de conversas/atendimentos/pendências/estado só gestão; `ulbra_leitura_usuario` própria; `ulbra_vinculos` INSERT/UPDATE/SELECT para `authenticated` (as funções Edge escrevem com service_role). Nada muda com retenção.
- Precedente no banco: já existem `whatsapp_retencao_mensal` e `whatsapp_expurgar_eventos_diario` no cron — a retenção da Mensageria, quando aprovada, deve seguir o mesmo padrão (função + execução manual/cron por decisão).

## 5. Diagnóstico do banco inteiro (somente leitura, 11/11/2026 11:54 UTC)

### 5.1 Espaço ocupado
- **Banco: 3,03 GB.** `public` 3,27 GB em objetos (inclui índices), `pg_toast` 0,78 GB, **`cron` 0,21 GB**, `storage` 9,5 MB, `auth` 3,3 MB.
- Maiores tabelas (total = heap + índices + toast):

| Tabela | total | heap | índices | toast | vivas | mortas | leitura |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `whatsapp_webhook_eventos` | **731 MB** | 28 MB | 12 MB | **691 MB** | 147.713 | 1.379 | payloads grandes (toast); já existe expurgo diário |
| `historico_operadores_alunos` | 382 MB | 304 MB | 78 MB | — | 21.789 | 32 | **~14 KB por linha** no heap: conferir o que a linha carrega |
| `audit_log` | 293 MB | 252 MB | 16 MB | 25 MB | **1.257** | 177 | **inchaço**: 252 MB de heap para 1,2 mil linhas vivas (faxina de 29/10 apagou, espaço não voltou — precisa VACUUM FULL/repack em janela) |
| `historico_agendamentos` | 241 MB | 201 MB | 40 MB | — | 20.944 | 12 | ~9,6 KB por linha: mesma conferência |
| `cron.job_run_details` | **211 MB** | 206 MB | 5 MB | — | 192.897 | — | histórico do pg_cron desde 11/07, **nunca expurgado** |
| `prime_extrato` | 171 MB | 84 MB | 87 MB | — | 419.464 | **60.687** | 12% de linhas mortas; índices maiores que o heap |
| `aluno_movimentacoes` | 141 MB | 101 MB | 40 MB | — | 2.689 | 11 | ~38 KB por linha?! (vivas pode estar desatualizado: autovacuum 0) |
| `prime_titulo_semestre` | 79 MB | 51 MB | 28 MB | — | 78 | 2.257 | **inchaço** após faxina |
| `alunos` | 61 MB | 25 MB | 37 MB | — | 18.831 | 699 | índices > heap |
| `casos` | 38 MB | 25 MB | 13 MB | — | 18.424 | 429 | ok |
| `ulbra_*` (todas) | < 1 MB | | | | | | irrelevante hoje |

Observação de método: `vivas/mortas` vêm de `pg_stat_user_tables` e várias tabelas têm `autovacuum_count = 0`/`autoanalyze_count = 0` — as estatísticas podem estar velhas; o tamanho em bytes é exato.

### 5.2 Carga de processamento
- **Cache:** heap 99,04 %, índices 99,81 % — o banco cabe na memória; a carga é de CPU/tempo de consulta, não de disco.
- **Conexões agora:** 30 (21 ociosas, 2 ativas, 7 de serviço). Nenhuma consulta de aplicação presa; só o slot de replicação do Realtime (normal).
- **`pg_stat_statements`** (acumulado desde o reset, 1,08 M chamadas, 16.719 s): 
  1. **Realtime (`SELECT wal->>…`)**: 160.852 chamadas, 15,4 % do tempo — o polling de replicação do Supabase Realtime; custo fixo do serviço.
  2. **Uma RPC via PostgREST com média de 12,1 s** × 119 chamadas (8,6 %): texto truncado (`pgrst_scalar … json_data`) — identificar pelo `queryid` numa medição dedicada; é a consulta mais pesada por chamada.
  3. **Jobs do cron embrulhados em `sistema_sob_carga()`**: 45 × 17,5 s e 45 × 10,3 s, 89 × 5,9 s, 88 × 2,5 s (≈ 12 % somados) — os jobs horários de casos/prime.
  4. RPC `p_op…` (**`ulbra_central_operador`**, pelo prefixo do parâmetro): **248 chamadas, média 2,96 s** (4,4 %). É a Central: 3 s por abertura é lento e vai piorar com a liberação geral e o polling de 60 s. Candidata a índice (`ulbra_vinculos(aluno_id) where desvinculado_em is null`, `casos(aluno_id, operador_email)`) e a revisão dos CTEs repetidos três vezes. **Fora do pacote de 12/11; registrar.**
  5. RPC `p_em…` (e-mail): 1.264 × 0,6 s; `aluno_movimentacoes` (3 variantes): ~16 mil chamadas, 80–260 ms cada (≈ 11 %); `whatsapp_sessao_credenciais` INSERT: 1.336 × 464 ms; `acordo_alertas_do_operador`: 260 × 0,9 s.
  6. Mais chamadas: normalização de telefone (`p_telefone`, 226 mil × 0,02 ms), `set_config` do PostgREST (250 mil), webhook do WhatsApp (19 mil inserts/updates).
- **Tabelas mais lidas por varredura sequencial:** `acordos` (108.584 seq scans, 566 M linhas lidas), `pagamentos` (170 M), `aluno_movimentacoes` (114 M), `acordos_titulos` (100 M), `prime_titulo_semestre` (71 M), `alunos` (56 M), `usuarios` (257.863 seq scans — tabela pequena, ok). `acordos` e `pagamentos` são as candidatas a índice/consulta revisada.
- **Mais escritas:** `carteira_efetividade_invalidacao` (85 mil updates), `mv_saude_carteira` (refresh diário recria 36 mil linhas), `whatsapp_webhook_eventos`, `projecao_snapshot_pagamentos` (29 mil insert/delete), `prime_extrato` (43 mil updates, 60 mil mortas), `alunos`/`casos` (~36 mil updates cada).
- **Cron:** 58 jobs cadastrados, 47 ativos; 19 falhas nos últimos 7 dias em `job_run_details`; jobs únicos de 29/10 (`faxina_*_unica`, `reativar_*_noite`) continuam marcados como ativos com data passada — limpar o cadastro (sem efeito de carga, mas confunde). Nenhum job da ULBRA (coleta: cron 0).

### 5.3 O que isto muda para a Mensageria
- Espaço: nada — `ulbra_*` somam menos de 1 MB e crescem ~2–3 MB/mês.
- Processamento: a Central (`ulbra_central_operador`, ~3 s por chamada) é o ponto a otimizar antes de ampliar polling/uso; a nova `ulbra_central_conversas` usa os mesmos CTEs e deve ser medida no CI/produção após o lote.
- Candidatos a limpeza **fora deste pacote**, cada um com decisão própria: `audit_log` e `prime_titulo_semestre` (recuperar espaço após faxina), `cron.job_run_details` (expurgo por idade), `historico_*` (conferir tamanho por linha), `prime_extrato` (vacuum/índices), cadastro do cron (jobs únicos vencidos).
