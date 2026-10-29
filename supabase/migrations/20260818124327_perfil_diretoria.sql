-- ============================================================================
-- Perfil "diretoria" — leitura executiva (2026-08-18)
-- ============================================================================
-- Contexto: a diretoria precisa acompanhar resultado, não operar a cobrança.
-- O acesso combinado é de QUATRO áreas, e só elas:
--
--   1. Visão Executiva  (/executivo  -> dashboard_executivo_snapshot)
--   2. DRE              (/dre        -> dre_snapshot)
--   3. Panorama 360     (/painel-carteira -> dashboard_carteira_360 /
--                        dashboard_gestao_geral / dashboard_ano_vs_ano /
--                        dashboard_saude_base_acionamento)
--   4. Relatório 2026/1 sem negociação (/relatorios-2026-1-sem-negociacao)
--
-- Decisões desta migration:
--
-- * NENHUMA policy de RLS é alterada. O Panorama 360 já é servido por RPCs
--   SECURITY DEFINER agregadas, sem gate de e-mail — então a diretoria vê o
--   consolidado da empresa sem que ninguém ganhe leitura nova em casos,
--   acordos, parcelas ou carteira de operador.
--
-- * usuario_e_gestao() NÃO é alterada de propósito. Ela guarda 37 policies de
--   SELECT, 27 de INSERT, 16 de UPDATE e 5 de DELETE. Emendar "diretoria" ali
--   sairia MUITO mais largo do que as quatro telas acima — daria, entre outras
--   coisas, DELETE em casos e escrita nas tabelas fin_*.
--
-- * A diretoria é identificada pelo PERFIL na tabela usuarios, não por e-mail
--   cravado. Trocar quem é diretor passa a ser edição de cadastro em
--   /usuarios, sem migration nova.
--
-- * Só LEITURA é liberada. atualizar_snapshots_gerenciais() (que recalcula os
--   snapshots) e relatorio_mensalidades_2026_1_capturar() (que grava o ponto
--   diário do histórico) continuam restritas à gestão e ao cron.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Quem é diretoria
-- ----------------------------------------------------------------------------
create or replace function public.usuario_e_diretoria()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.usuarios u
    where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and u.ativo is true
      and u.perfil = 'diretoria'
  );
$$;
revoke all on function public.usuario_e_diretoria() from public;
grant execute on function public.usuario_e_diretoria() to authenticated;
comment on function public.usuario_e_diretoria() is
  'True para usuário ATIVO com perfil diretoria. Perfil de leitura executiva: Visão Executiva, DRE, Panorama 360 e relatório 2026/1 sem negociação.';

-- ----------------------------------------------------------------------------
-- 2. Leitura dos snapshots gerenciais (Visão Executiva + DRE)
-- ----------------------------------------------------------------------------
-- Gate NOVO e só de leitura. snapshot_gerencial_e_gestao() continua existindo,
-- intocada, guardando a ESCRITA em atualizar_snapshots_gerenciais().
create or replace function public.snapshot_gerencial_pode_ler()
returns boolean language sql stable security definer set search_path = public as $$
  select public.snapshot_gerencial_e_gestao() or public.usuario_e_diretoria();
$$;
revoke all on function public.snapshot_gerencial_pode_ler() from public;
grant execute on function public.snapshot_gerencial_pode_ler() to authenticated;
comment on function public.snapshot_gerencial_pode_ler() is
  'Leitura dos snapshots gerenciais: gestão (allowlist) + diretoria. A escrita segue em snapshot_gerencial_e_gestao().';

-- Corpos IDÊNTICOS aos de produção; muda só a linha do gate.
create or replace function public.dashboard_executivo_snapshot()
returns json language plpgsql security definer set search_path = public as $$
declare v_payload jsonb;
begin
  if not public.snapshot_gerencial_pode_ler() then raise exception 'Sem permissão.'; end if;
  select payload into v_payload from public.snapshot_gerencial where chave='executivo' and ano=0;
  if v_payload is null then
    v_payload := public.dashboard_executivo()::jsonb;
    insert into public.snapshot_gerencial(chave, ano, payload, gerado_por) values ('executivo', 0, v_payload, 'bootstrap')
      on conflict (chave, ano) do update set payload=excluded.payload, gerado_em=now();
  end if;
  return v_payload::json;
end; $$;

create or replace function public.dre_snapshot(p_ano integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_payload jsonb;
begin
  if not public.snapshot_gerencial_pode_ler() then raise exception 'Sem permissão.'; end if;
  select payload into v_payload from public.snapshot_gerencial where chave='dre' and ano=p_ano;
  if v_payload is null then
    v_payload := public.dre_dados(p_ano);
    insert into public.snapshot_gerencial(chave, ano, payload, gerado_por) values ('dre', p_ano, v_payload, 'bootstrap')
      on conflict (chave, ano) do update set payload=excluded.payload, gerado_em=now();
  end if;
  return v_payload;
end; $$;

create or replace function public.snapshot_gerencial_meta(p_chave text, p_ano integer default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if not public.snapshot_gerencial_pode_ler() then raise exception 'Sem permissão.'; end if;
  select gerado_em, gerado_por into r from public.snapshot_gerencial where chave=p_chave and ano=coalesce(p_ano,0);
  if not found then return jsonb_build_object('gerado_em', null); end if;
  return jsonb_build_object('gerado_em', r.gerado_em, 'gerado_por', r.gerado_por);
end; $$;

-- ----------------------------------------------------------------------------
-- 3. Relatório 2026/1 sem negociação — leitura
-- ----------------------------------------------------------------------------
-- Só o gate muda: a allowlist de gestão ganha "or usuario_e_diretoria()".
-- O corpo (consulta, agregações e payload) é o mesmo de produção.
-- relatorio_mensalidades_2026_1_capturar() NÃO é tocada: gravar o ponto do dia
-- no histórico continua sendo da gestão e do cron.
create or replace function public.relatorio_mensalidades_2026_1_sem_negociacao()
returns jsonb language plpgsql stable security definer set search_path = public as $$
DECLARE
  v_email text := lower(coalesce(auth.email(),''));
  v_gestao boolean := v_email IN ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br')
                      OR public.usuario_e_diretoria();
  v_out jsonb;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND NOT v_gestao THEN
    RAISE EXCEPTION 'Acesso negado: relatorio restrito a gestao.' USING ERRCODE='42501';
  END IF;

  WITH eleg AS (SELECT * FROM public._relatorio_2026_1_eleg()),
  por_mes AS (
    SELECT g.mes AS mes_numero,
      (array['Janeiro','Fevereiro','Março','Abril','Maio','Junho'])[g.mes] AS mes_nome,
      count(distinct e.cpf) AS cpfs, count(distinct e.aluno_id) AS alunos_unicos,
      count(e.id) AS mensalidades_sem_negociacao, round(coalesce(sum(e.saldo),0),2) AS saldo_sem_negociacao
    FROM generate_series(1,6) g(mes) LEFT JOIN eleg e ON e.mes = g.mes GROUP BY g.mes
  ),
  por_curso AS (SELECT curso, count(*) AS mensalidades, count(distinct aluno_id) AS alunos, round(sum(saldo),2) AS saldo FROM eleg GROUP BY curso),
  por_unidade AS (SELECT unidade, count(*) AS mensalidades, count(distinct aluno_id) AS alunos, round(sum(saldo),2) AS saldo FROM eleg GROUP BY unidade),
  por_faixa AS (SELECT faixa, faixa_ordem, count(*) AS mensalidades, count(distinct aluno_id) AS alunos, round(sum(saldo),2) AS saldo FROM eleg GROUP BY faixa, faixa_ordem),
  tot AS (SELECT count(distinct cpf) AS cpfs, count(distinct aluno_id) AS alunos, count(*) AS mens, round(coalesce(sum(saldo),0),2) AS saldo FROM eleg),
  conf AS (SELECT count(distinct s.aluno_id) AS n FROM public.solicitacoes_confirmacao_pagamento s
    WHERE s.status='AGUARDANDO_CONFIRMACAO' AND s.motivo ILIKE 'Gerado do import de pagamentos Santander%')
  SELECT jsonb_build_object(
    'meses', (SELECT coalesce(jsonb_agg(p ORDER BY p.mes_numero),'[]'::jsonb) FROM por_mes p),
    'por_curso', (SELECT coalesce(jsonb_agg(c ORDER BY c.saldo DESC),'[]'::jsonb) FROM por_curso c),
    'por_unidade', (SELECT coalesce(jsonb_agg(u ORDER BY u.saldo DESC),'[]'::jsonb) FROM por_unidade u),
    'por_faixa', (SELECT coalesce(jsonb_agg(f ORDER BY f.faixa_ordem DESC),'[]'::jsonb) FROM por_faixa f),
    'destaques', jsonb_build_object(
      'curso_maior_inadimplencia',   (SELECT to_jsonb(c) FROM por_curso c ORDER BY c.saldo DESC LIMIT 1),
      'unidade_maior_inadimplencia', (SELECT to_jsonb(u) FROM por_unidade u ORDER BY u.saldo DESC LIMIT 1),
      'unidade_maior_volume',        (SELECT to_jsonb(u) FROM por_unidade u ORDER BY u.mensalidades DESC LIMIT 1),
      'faixa_maior_saldo',           (SELECT to_jsonb(f) FROM por_faixa f ORDER BY f.saldo DESC LIMIT 1),
      'faixa_maior_volume',          (SELECT to_jsonb(f) FROM por_faixa f ORDER BY f.mensalidades DESC LIMIT 1),
      'mes_maior_inadimplencia',     (SELECT to_jsonb(p) FROM por_mes p ORDER BY p.saldo_sem_negociacao DESC LIMIT 1),
      'mes_maior_volume',            (SELECT to_jsonb(p) FROM por_mes p ORDER BY p.mensalidades_sem_negociacao DESC LIMIT 1)
    ),
    'evolucao_diaria', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'dia', s.dia, 'cpfs', s.cpfs, 'alunos', s.alunos, 'mensalidades', s.mensalidades,
        'saldo', s.saldo, 'origem', s.origem
      ) ORDER BY s.dia),'[]'::jsonb) FROM public.relatorio_mens_2026_1_snapshot s),
    'alunos_unicos_semestre', (SELECT alunos FROM tot),
    'cpfs_semestre', (SELECT cpfs FROM tot),
    'mensalidades_total', (SELECT mens FROM tot),
    'saldo_total', (SELECT saldo FROM tot),
    'casos_em_confirmacao', (SELECT n FROM conf),
    'casos_em_revisao_manual', 0,
    'atualizado_em', now()
  ) INTO v_out;
  RETURN v_out;
END;
$$;

-- ============================================================================
-- O que a diretoria NÃO ganha com esta migration (conferido, tem de continuar
-- negando): Calibragem (calibragem_e_gestao), Fechamento de Remuneração,
-- Borderôs/Importações (app_pode_borderos_importacoes), catálogo de Tabulações
-- (usuario_pode_editar_tabulacoes), gerir usuários, e qualquer escrita coberta
-- por usuario_e_gestao(). As tabelas dre_* seguem privativas da Amanda
-- (policy dre_priv), então o DRE é leitura para a diretoria.
-- ============================================================================
