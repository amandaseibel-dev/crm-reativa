-- ===========================================================================
-- GIRO 2026/1 e 2026/2 -- CONFERENCIA DO EVENTO ADMINISTRATIVO NA FICHA
--
-- SOMENTE SELECT. Rodar o BLOCO 1 antes do backfill e o BLOCO 2 depois; o
-- BLOCO 3 e a prova de que o giro em si nao foi tocado, e vale nos dois
-- momentos (os numeros tem de ser identicos antes e depois).
--
-- Contexto: docs/GIRO-CARTEIRAS-2026-1-2026-2-SIMULACAO.md, secao 6.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- BLOCO 1 -- ANTES. Medido em 16/10/2026, depois do giro e antes do backfill:
--   auditoria 3.922 | com troca real 3.772 | alunos com troca 3.665
--   ja registrados 0 | sincronizacao do gatilho 3.792 (2.644 sem anterior)
-- ---------------------------------------------------------------------------
select jsonb_pretty(jsonb_build_object(
  'auditoria_do_giro',        (select count(*) from public.calibragem_auditoria
                                where simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'),
  'casos_com_troca_real',     (select count(*) from public.calibragem_auditoria
                                where simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'
                                  and operador_anterior_email is distinct from operador_novo_email),
  'alunos_com_troca_real',    (select count(distinct aluno_id) from public.calibragem_auditoria
                                where simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'
                                  and evento = 'MOVIMENTACAO_NIVELAMENTO'
                                  and operador_anterior_email is distinct from operador_novo_email
                                  and aluno_id is not null),
  'alunos_sem_troca',         (select count(distinct aluno_id) from public.calibragem_auditoria a
                                where a.simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'
                                  and a.aluno_id not in (
                                    select aluno_id from public.calibragem_auditoria
                                     where simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'
                                       and operador_anterior_email is distinct from operador_novo_email)),
  'ja_registrados_no_lote',   (select count(*) from public.aluno_movimentacoes
                                where giro_simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'),
  'sincronizacao_do_gatilho', (select count(*) from public.aluno_movimentacoes
                                where tipo = 'REDISTRIBUICAO_SINCRONIZACAO'
                                  and registrado_em between timestamptz '2026-10-16 11:55:00+00'
                                                        and timestamptz '2026-10-16 13:00:00+00'),
  'dessas_sem_operador_anterior', (select count(*) from public.aluno_movimentacoes
                                where tipo = 'REDISTRIBUICAO_SINCRONIZACAO'
                                  and operador_anterior_email is null
                                  and registrado_em between timestamptz '2026-10-16 11:55:00+00'
                                                        and timestamptz '2026-10-16 13:00:00+00')
)) as antes;


-- ---------------------------------------------------------------------------
-- BLOCO 2 -- DEPOIS. O que o backfill tem de ter produzido.
--   linhas = alunos = 3.665 | um tipo so | giro_simulacao_id em 100% | data original
-- ---------------------------------------------------------------------------
select jsonb_pretty(jsonb_build_object(
  'linhas_do_lote',      (select count(*) from public.aluno_movimentacoes
                           where giro_simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'),
  'alunos_distintos',    (select count(distinct aluno_id) from public.aluno_movimentacoes
                           where giro_simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'),
  'bate_com_a_auditoria',(select count(distinct aluno_id) from public.calibragem_auditoria
                           where simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'
                             and evento = 'MOVIMENTACAO_NIVELAMENTO'
                             and operador_anterior_email is distinct from operador_novo_email
                             and aluno_id is not null)
                        = (select count(*) from public.aluno_movimentacoes
                            where giro_simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'),
  'tipos_usados',        (select jsonb_object_agg(tipo, n) from
                           (select tipo, count(*) n from public.aluno_movimentacoes
                             where giro_simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'
                             group by tipo) z),
  'origem_declarada',    (select jsonb_build_object(
                             'veio_do_pool', count(*) filter (where operador_anterior_email is null),
                             'trocou_de_operador', count(*) filter (where operador_anterior_email is not null))
                           from public.aluno_movimentacoes
                           where giro_simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'),
  'sem_responsavel_novo',(select count(*) from public.aluno_movimentacoes
                           where giro_simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'
                             and operador_novo_email is null),
  'fora_da_data_do_giro',(select count(*) from public.aluno_movimentacoes
                           where giro_simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'
                             and (registrado_em < timestamptz '2026-10-16 11:55:00+00'
                               or registrado_em > timestamptz '2026-10-16 13:00:00+00')),
  'aluno_sem_troca_que_entrou', (select count(*) from public.aluno_movimentacoes m
                           where m.giro_simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'
                             and not exists (select 1 from public.calibragem_auditoria a
                                              where a.simulacao_id = m.giro_simulacao_id and a.aluno_id = m.aluno_id
                                                and a.operador_anterior_email is distinct from a.operador_novo_email))
)) as depois;


-- ---------------------------------------------------------------------------
-- BLOCO 3 -- O GIRO SEGUE INTACTO. Identico antes e depois do backfill.
--   3.808 CPFs | 544 por operador | 3.922 casos marcados | 0 divergencias
-- ---------------------------------------------------------------------------
select jsonb_pretty(jsonb_build_object(
  'cpfs_distribuidos',   (select count(distinct aluno_id) from public.casos
                           where giro_fidelizacao_ate is not null),
  'cpfs_por_operador',   (select jsonb_object_agg(nome, cpfs) from
                           (select u.nome, count(distinct c.aluno_id) cpfs
                              from public.casos c join public.usuarios u on u.email = c.operador_email
                             where c.giro_fidelizacao_ate is not null group by u.nome) z),
  'casos_fidelizados',   (select count(*) from public.casos
                           where giro_fidelizacao_ate = date '2026-10-26'),
  'auditoria_intacta',   (select count(*) from public.calibragem_auditoria
                           where simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'),
  'responsavel_divergente', (select count(*) from public.calibragem_auditoria a
                              join public.casos c on c.id = a.caso_id
                             where a.simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770'
                               and lower(coalesce(c.operador_email,'')) <> lower(coalesce(a.operador_novo_email,''))),
  'sincronia_caso_ficha',(select count(*) from public.casos c join public.alunos al on al.id = c.aluno_id
                           where c.giro_fidelizacao_ate is not null
                             and lower(coalesce(al.responsavel_atual_email,''))
                                 is distinct from lower(coalesce(c.operador_email,''))),
  'acordos_ativos',      (select count(*) from public.acordos where status = 'ATIVO')
)) as giro_intacto;


-- ---------------------------------------------------------------------------
-- BLOCO 4 -- NAO VIROU ACIONAMENTO. A prova de que o registro administrativo
-- nao mexeu em ultimo contato, fidelizacao, retorno nem produtividade.
-- ---------------------------------------------------------------------------
select jsonb_pretty(jsonb_build_object(
  'alteracao_operador_e_acionamento', public.eh_tipo_acionamento('ALTERACAO_OPERADOR'),
  'alunos_do_lote_com_acionamento_hoje', (select count(*) from public.alunos al
     where al.id in (select aluno_id from public.aluno_movimentacoes
                      where giro_simulacao_id = '437f434b-e781-4357-a5ef-3fcd8e9d4770')
       and al.data_ultimo_acionamento = (now() at time zone 'America/Sao_Paulo')::date),
  'casos_do_giro_fora_da_fidelizacao', (select count(*) from public.casos
     where giro_fidelizacao_ate is not null
       and not public.caso_em_giro_fidelizacao(giro_fidelizacao_ate))
)) as sem_efeito_colateral;
