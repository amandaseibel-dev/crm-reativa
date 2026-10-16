-- ===========================================================================
-- GIRO TOTAL DAS CARTEIRAS 2026/1 E 2026/2 -- SIMULACAO (16/10/2026)
--
-- SOMENTE SELECT. Nenhuma consulta deste arquivo escreve, cria objeto ou grava
-- simulacao. Rodado em producao (ahattpqrjmhkzsmnbdzs) pelo SQL Editor.
-- Resultados: docs/GIRO-CARTEIRAS-2026-1-2026-2-SIMULACAO.md
-- Desenho e decisoes: docs/GIRO-CARTEIRAS-2026-1-2026-2-DESENHO.md
--
-- ARMADILHA MEDIDA, nao repetir: a primeira versao destas consultas juntava
-- `public.calibragem_saldo_aluno` para ler `saldo_acordo`. Essa view recalcula
-- a base INTEIRA a cada chamada (soma todos os titulos chamando
-- titulo_superado_por_acordo de novo, mais todas as parcelas) e estourou o
-- statement timeout do SQL Editor. Aqui o saldo de acordo e computado direto de
-- `parcelas` + `acordos`, restrito aos alunos candidatos: as mesmas regras da
-- view, em 20-30 s em vez de timeout.
--
-- CONVENCOES, todas com motivo:
--   * Universo = `acordos_titulos` em aberto, SEM acordo (`acordo_id is null`,
--     sem vinculo ativo, nao superado por acordo) e `tipo_boleto <> 'Acordo'`.
--     Honorario nao e titulo (vive como `valor_honorario` em pagamentos), logo
--     nao entra por construcao.
--   * Valor = coalesce(saldo_corrigido, valor_em_aberto, valor_original, 0) --
--     a mesma formula da view calibragem_saldo_aluno, para o giro nao inventar
--     uma oitava formula de saldo.
--   * Semestre por TITULO, HIBRIDO: `prime_titulo_semestre` (janela do contrato
--     da serie, fonte oficial da integracao) quando houver, mes de vencimento
--     como fallback. O BLOCO 2 mede a divergencia entre os dois metodos.
--   * Unidade = cpf_chave: CPF limpo quando existe, `caso:<id>` quando vazio --
--     nunca colapsar CPF vazio num bucket unico.
--   * Saldo do cpf_chave soma por ALUNO_ID DISTINTO, nunca por caso.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- BLOCO 0 -- ESTRUTURA E DERIVA (independente)
-- Medido em 16/10: colunas de casos 7 de 8 (fidelizacao_inicio NAO existe em
-- producao), usuarios 3 de 3, view 1, funcoes 8 de 8, as duas portas do giro
-- desativadas, crons de liberacao e nivelamento ATIVOS.
-- ---------------------------------------------------------------------------
select
  (select string_agg(column_name, ', ' order by column_name) from information_schema.columns
    where table_schema='public' and table_name='casos'
      and column_name in ('operador_email','operador_nome','operador','operador_mensalidade_email',
        'operador_mensalidade_nome','mensalidade_girada_em','data_ultimo_acionamento','fidelizacao_inicio')
  ) as colunas_casos_presentes,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('calibragem_simular_giro_2026',
      'calibragem_executar_giro_lote_impl','calibragem_desfazer_nivelamento_lote',
      'caso_protegido_redistribuicao','caso_encerrado_operacional',
      'caso_dentro_prazo_fidelizacao','liberar_fidelizacao_caso','titulo_superado_por_acordo')
  ) as funcoes_esperadas_de_8,
  position('GIRO_DESATIVADO' in
    pg_get_functiondef('public.calibragem_simular_giro_2026(jsonb)'::regprocedure)) > 0 as simular_desativado,
  position('GIRO_DESATIVADO' in
    pg_get_functiondef('public.calibragem_executar_giro_lote_impl(uuid,integer)'::regprocedure)) > 0 as executar_desativado,
  (select string_agg(jobname || ' [' || schedule || '] ativo ' || active::text, ' ;; ' order by jobname)
     from cron.job where jobname ~ 'fideliz|nivelamento|giro|reposicao|calibragem') as crons_relevantes;


-- ---------------------------------------------------------------------------
-- BLOCO 1 -- QUEM RECEBE (independente)
-- Medido em 16/10: 7 operadores ativos, todos com recebe_novos_casos true.
-- ---------------------------------------------------------------------------
select jsonb_build_object(
 'operadores', (select jsonb_agg(jsonb_build_object('email',u.email,'nome',u.nome,
     'recebe',coalesce(u.recebe_novos_casos,true),
     'casos_hoje',(select count(*) from public.casos c where c.operador_email = u.email)) order by u.email)
   from public.usuarios u where u.ativo and u.perfil = 'operador'),
 'ativos_por_perfil', (select jsonb_object_agg(coalesce(perfil,'(nulo)'), n)
   from (select perfil, count(*) n from public.usuarios where ativo group by perfil) t),
 'inativos', (select count(*) from public.usuarios where not ativo)
) as r;


-- ---------------------------------------------------------------------------
-- BLOCO 2 -- OS DOIS METODOS DE SEMESTRE, CRUZADOS (independente)
-- Rodar ANTES de fechar a Decisao 1. ~10 s.
-- ---------------------------------------------------------------------------
with tit as (
  select t.id, t.aluno_id, t.vencimento,
         round(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0),2) valor,
         ps.semestre sem_prime,
         case when t.vencimento >= date '2026-01-01' and t.vencimento < date '2026-07-01' then '2026/1'
              when t.vencimento >= date '2026-07-01' and t.vencimento < date '2027-01-01' then '2026/2' end sem_venc
    from public.acordos_titulos t
    left join public.prime_titulo_semestre ps on ps.boleto = t.documento
   where upper(coalesce(t.situacao,'')) = 'ABERTO' and lower(coalesce(t.status,'')) = 'em_aberto'
     and t.acordo_id is null and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo,true))
     and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento)
)
select (select jsonb_object_agg(k, v) from (
  select coalesce(sem_venc,'venc fora de 2026') || '  ->  ' || coalesce(sem_prime,'prime ausente') as k,
         jsonb_build_object('titulos', count(*), 'valor', round(sum(valor),2)) as v
    from tit where sem_venc in ('2026/1','2026/2') or sem_prime in ('2026/1','2026/2')
   group by 1) z) as r;


-- ===========================================================================
-- BASE DOS BLOCOS 3, 4 e 5. Cole este trecho e, LOGO EM SEGUIDA, o select do
-- bloco desejado (o trecho termina em virgula de CTE de proposito).
-- Custo medido: 20-30 s. A parte cara sao as duas funcoes de protecao, uma
-- chamada por caso candidato -- por isso `caso_cand` ja nasce restrita.
-- ===========================================================================
-- with tit as (
--   select t.id, t.aluno_id,
--          round(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0),2) valor,
--          coalesce(ps.semestre,
--            case when t.vencimento >= date '2026-01-01' and t.vencimento < date '2026-07-01' then '2026/1'
--                 when t.vencimento >= date '2026-07-01' and t.vencimento < date '2027-01-01' then '2026/2' end) semestre
--     from public.acordos_titulos t
--     left join public.prime_titulo_semestre ps on ps.boleto = t.documento
--    where upper(coalesce(t.situacao,'')) = 'ABERTO' and lower(coalesce(t.status,'')) = 'em_aberto'
--      and t.acordo_id is null and coalesce(t.tipo_boleto,'') <> 'Acordo'
--      and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo,true))
--      and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento)
-- ), uni as (select * from tit where semestre in ('2026/1','2026/2') and valor > 0 and aluno_id is not null
-- ), por_aluno as (
--   select aluno_id, count(*) titulos, round(sum(valor),2) saldo,
--          count(*) filter (where semestre = '2026/1') t1,
--          count(*) filter (where semestre = '2026/2') t2 from uni group by aluno_id
-- ), acordo as (                       -- mesmas regras da view, so para os candidatos
--   select a.aluno_id from public.parcelas p join public.acordos a on a.id = p.acordo_id
--    where a.aluno_id in (select aluno_id from por_aluno)
--      and lower(coalesce(a.status,'')) not in ('cancelado','cancelada')
--      and upper(coalesce(p.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
--    group by a.aluno_id
-- ), caso_cand as (
--   select c.id, c.aluno_id, c.data_ultimo_acionamento dua, lower(coalesce(c.operador_email,'')) dono,
--          coalesce(nullif(regexp_replace(coalesce(c.cpf_limpo, c.cpf, ''), '\D', '', 'g'),''), 'caso:' || c.id::text) cpf_caso,
--          public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
--            c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado) protegido,
--          public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
--            c.status_financeiro, c.status_jornada) encerrado
--     from public.casos c where c.aluno_id in (select aluno_id from por_aluno)
-- ), chave as (select aluno_id, min(cpf_caso) cpf_chave from caso_cand group by aluno_id
-- ), elegivel as (
--   select pa.aluno_id, pa.titulos, pa.saldo, pa.t1, pa.t2, ch.cpf_chave
--     from por_aluno pa join chave ch on ch.aluno_id = pa.aluno_id
--    where pa.aluno_id not in (select aluno_id from acordo)
--      and exists (select 1 from caso_cand k where k.aluno_id = pa.aluno_id and not k.protegido and not k.encerrado)
-- ), por_cpf as (select cpf_chave, round(sum(saldo),2) saldo, sum(titulos) titulos,
--      bool_or(t1 > 0) tem1, bool_or(t2 > 0) tem2 from elegivel group by cpf_chave
-- ), ops as (select row_number() over (order by u.email) - 1 slot, u.email, u.nome
--      from public.usuarios u where u.ativo and u.perfil = 'operador' and coalesce(u.recebe_novos_casos, true)
-- ), n as (select count(*)::int q from ops
-- ), fila as (select p.*, row_number() over (order by p.saldo desc, p.cpf_chave) - 1 r from por_cpf p
-- ), atrib as (select f.*, case when (f.r / n.q) % 2 = 0 then f.r % n.q
--                               else n.q - 1 - (f.r % n.q) end slot from fila f cross join n
-- ), destino as (select a.*, o.email para, o.nome para_nome from atrib a join ops o on o.slot = a.slot
-- ), dono as (select ch.cpf_chave, count(distinct k.dono) donos, min(k.dono) dono
--      from chave ch join caso_cand k on k.aluno_id = ch.aluno_id group by ch.cpf_chave
-- ), por_op as (select para, para_nome, count(*) cpfs, count(*) filter (where tem1) c1,
--      count(*) filter (where tem2) c2, sum(titulos) tit, round(sum(saldo),2) saldo
--      from destino group by para, para_nome)


-- ---------------------------------------------------------------------------
-- BLOCO 3 (BASE + este select) -- RELATORIO POR OPERADOR, em linhas.
-- Medido em 16/10: 7 linhas, 3.807 CPFs, 9.091 titulos, R$ 11.520.786,55.
-- ---------------------------------------------------------------------------
-- select para_nome as operador,
--        count(*) filter (where tem1) as cpfs_2026_1,
--        count(*) filter (where tem2) as cpfs_2026_2,
--        count(*)                     as cpfs_unicos,
--        sum(titulos)                 as titulos,
--        round(sum(saldo),2)          as saldo_total,
--        round(100.0 * sum(saldo) / (select sum(saldo) from destino), 2) as pct_saldo
--   from destino group by para_nome order by para_nome;


-- ---------------------------------------------------------------------------
-- BLOCO 4 (BASE + este select) -- TOTAIS, EQUILIBRIO E VALIDACOES.
-- Medido em 16/10: dif_cpfs 1, dif_saldo R$ 3.986,36 (0,24%), soma_confere
-- true, cpf_em_2_operadores 0, mudam 3.660, permanecem 147, hoje_sem_dono 2.644.
-- ---------------------------------------------------------------------------
-- select jsonb_build_object(
--  'totais', jsonb_build_object(
--    'cpfs', (select count(*) from por_cpf), 'titulos', (select sum(titulos) from por_cpf),
--    'saldo', (select round(sum(saldo),2) from por_cpf), 'operadores', (select q from n),
--    'media_cpfs', (select round(avg(cpfs),1) from por_op),
--    'media_saldo', (select round(avg(saldo),2) from por_op),
--    'dif_cpfs', (select max(cpfs) - min(cpfs) from por_op),
--    'dif_saldo', (select round(max(saldo) - min(saldo),2) from por_op),
--    'dif_saldo_pct', (select round(100.0 * (max(saldo) - min(saldo)) / nullif(max(saldo),0), 2) from por_op),
--    'soma_confere', (select round(sum(saldo),2) from por_cpf)
--                    is not distinct from (select round(sum(saldo),2) from por_op),
--    'cpf_em_2_operadores', (select count(*) from
--      (select cpf_chave from destino group by cpf_chave having count(*) > 1) z)),
--  'movimento', jsonb_build_object(
--    'permanecem', (select count(*) from destino d join dono o on o.cpf_chave = d.cpf_chave
--                    where o.donos = 1 and o.dono = d.para),
--    'mudam', (select count(*) from destino d join dono o on o.cpf_chave = d.cpf_chave
--                    where not (o.donos = 1 and o.dono = d.para)),
--    'hoje_sem_dono', (select count(*) from destino d join dono o on o.cpf_chave = d.cpf_chave
--                    where o.donos = 1 and o.dono = ''))
-- ) as r;


-- ---------------------------------------------------------------------------
-- BLOCO 5 (BASE reduzida + este select) -- PARTICAO DO UNIVERSO E RISCO DE
-- REVERSAO. Nao precisa de ops/fila/atrib/destino/dono/por_op; precisa de
-- `classif` e `movidos`, abaixo, apos `chave`.
-- Medido em 16/10: particao fecha em 5.568 alunos / 12.147 titulos /
-- R$ 18.099.144,99; 3.943 casos recebem novo dono e 525 ja estao fora da
-- janela de 10 dias (seriam soltos pelo cron na primeira manha).
-- ---------------------------------------------------------------------------
-- ), classif as (
--   select pa.aluno_id, pa.titulos, pa.saldo,
--          case when pa.aluno_id in (select aluno_id from acordo) then '2_acordo_ativo'
--               when ch.aluno_id is null then '3_sem_ficha_no_crm'
--               when not exists (select 1 from caso_cand k where k.aluno_id = pa.aluno_id
--                                 and not k.protegido and not k.encerrado)
--                 then '4_caso_protegido_ou_encerrado'
--               else '1_distribuido' end motivo
--     from por_aluno pa left join chave ch on ch.aluno_id = pa.aluno_id
-- ), movidos as (
--   select k.id, k.dua from caso_cand k
--    where k.aluno_id in (select aluno_id from classif where motivo = '1_distribuido')
-- )
-- select jsonb_build_object(
--  'particao', (select jsonb_object_agg(motivo, jsonb_build_object('alunos', n, 'titulos', t, 'saldo', v))
--    from (select motivo, count(*) n, sum(titulos) t, round(sum(saldo),2) v from classif group by motivo) z),
--  'universo', jsonb_build_object('alunos', (select count(*) from classif),
--    'titulos', (select sum(titulos) from classif), 'saldo', (select round(sum(saldo),2) from classif)),
--  'risco_reversao', jsonb_build_object(
--    'casos_que_recebem_novo_dono', (select count(*) from movidos),
--    'ja_fora_da_janela_10_dias', (select count(*) from movidos
--      where not public.caso_dentro_prazo_fidelizacao(dua)),
--    'sem_acionamento_nenhum', (select count(*) from movidos where dua is null),
--    'carteira_toda_com_dono', (select count(*) from public.casos where coalesce(operador_email,'') <> ''),
--    'carteira_toda_fora_da_janela', (select count(*) from public.casos
--      where coalesce(operador_email,'') <> ''
--        and not public.caso_dentro_prazo_fidelizacao(data_ultimo_acionamento)))
-- ) as r;
