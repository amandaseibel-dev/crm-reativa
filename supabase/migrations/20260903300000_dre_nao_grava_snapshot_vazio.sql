-- ============================================================================
-- DRE zerado: o snapshot parava de ser o DRE e virava um "sem_acesso"
-- ----------------------------------------------------------------------------
-- Sintoma (Amanda, 03/09/2026): "DRE de 2026 nao esta aparecendo" -- a tela
-- abre no ano certo e mostra R$ 0,00 em todos os meses.
--
-- Causa: atualizar_snapshots_gerenciais() aceita a allowlist de gestao
-- (amanda, cobranca04, cobranca07) e tambem o caminho server-side (jwt nulo).
-- Mas dre_dados() so responde ao e-mail da Amanda -- para todos os outros
-- devolve o objeto {"erro":"sem_acesso"}. Como esse objeto e um jsonb valido,
-- ele era gravado POR CIMA do DRE do ano em snapshot_gerencial. Dali em diante
-- dre_snapshot() servia o "sem_acesso" para todo mundo, inclusive para a
-- Amanda, e o payload sem a chave 'meses' virava tabela vazia na tela.
-- Bastava a Fernanda clicar "Atualizar projecao" para o DRE do ano sumir; so
-- voltava quando a propria Amanda clicasse de novo.
--
-- Correcao, em tres camadas -- porque um portao de leitura nunca deveria ter
-- virado conteudo gravavel:
--   1. _dre_dados_calcula(): o CALCULO, sem portao, privado do banco. Quem
--      chama ja checou permissao. Nao ha grant para authenticated.
--   2. dre_dados(): segue exclusiva da Amanda, mas agora LEVANTA EXCECAO em
--      vez de devolver um payload de erro. Erro nao se guarda em cache.
--   3. dre_snapshot() / atualizar_snapshots_gerenciais(): so gravam payload
--      que tenha 'meses', e dre_snapshot() recalcula se achar snapshot
--      envenenado guardado. Um payload ruim nunca mais sobrescreve um bom.
-- Quem ve o que NAO muda: a escrita segue na allowlist de gestao, a leitura
-- segue em snapshot_gerencial_pode_ler() (gestao + diretoria) e as tabelas
-- dre_* seguem privativas da Amanda pela policy dre_priv.
-- Reversivel: supabase/rollbacks/20260903300000_*.rollback.sql
-- ============================================================================

begin;

-- 1. O CALCULO, sem portao -------------------------------------------------
-- Corpo identico ao dre_dados() que estava em producao, menos a checagem de
-- e-mail. Privado: sem grant, so alcancavel de dentro de outra SECURITY
-- DEFINER que ja tenha verificado quem esta chamando.
create or replace function public._dre_dados_calcula(p_ano integer)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ano', p_ano,
    'meses', (
      select coalesce(jsonb_agg(x order by x.mes),'[]') from (
        select m.mes,
          coalesce(hon.honorarios,0) as faturamento_calc,
          fo.valor as faturamento_override,
          coalesce(fo.valor, coalesce(hon.honorarios,0)) as faturamento,
          coalesce(fl.folha,0) as folha_total,
          coalesce(dp.despesas,0) as despesas_total,
          (coalesce(fo.valor, coalesce(hon.honorarios,0)) - coalesce(fl.folha,0) - coalesce(dp.despesas,0)) as lucro
        from generate_series(1,12) m(mes)
        left join lateral (
          select round(coalesce(sum(vh),0),2) honorarios from (
            select coalesce(valor_honorario,0) vh from public.pagamentos
              where extract(year from data_pagamento)=p_ano and extract(month from data_pagamento)=m.mes
            union all
            select coalesce(valor_honorario,0) from public.recuperacao_historica
              where extract(year from competencia)=p_ano and extract(month from competencia)=m.mes
          ) z
        ) hon on true
        left join public.dre_faturamento fo on fo.competencia = make_date(p_ano, m.mes, 1)
        left join lateral (
          select round(coalesce(sum(remuneracao+premiacao),0),2) folha from public.dre_folha
          where extract(year from competencia)=p_ano and extract(month from competencia)=m.mes
        ) fl on true
        left join lateral (
          select round(coalesce(sum(valor),0),2) despesas from public.dre_despesa
          where extract(year from competencia)=p_ano and extract(month from competencia)=m.mes
        ) dp on true
      ) x
    ),
    'funcionarios', (select coalesce(jsonb_agg(f order by f.ativo desc, f.nome),'[]') from (
        select id, nome, funcao, tipo, salario_base, ativo, data_inicio, data_fim, observacao from public.dre_funcionario) f),
    'categorias', (select coalesce(jsonb_agg(c order by c.ordem, c.nome),'[]') from (
        select id, nome, ordem from public.dre_despesa_categoria) c),
    'folha_detalhe', (select coalesce(jsonb_agg(fd),'[]') from (
        select funcionario_id, to_char(competencia,'YYYY-MM') mes, remuneracao, premiacao, faixa_meta
        from public.dre_folha where extract(year from competencia)=p_ano) fd),
    'despesa_detalhe', (select coalesce(jsonb_agg(dd),'[]') from (
        select categoria_id, to_char(competencia,'YYYY-MM') mes, valor
        from public.dre_despesa where extract(year from competencia)=p_ano) dd)
  );
$$;
revoke all on function public._dre_dados_calcula(integer) from public;
revoke all on function public._dre_dados_calcula(integer) from authenticated;
revoke all on function public._dre_dados_calcula(integer) from anon;
comment on function public._dre_dados_calcula(integer) is
  'Calculo do DRE do ano, SEM portao. Privado: quem chama e responsavel por checar a permissao. Ver dre_dados() e dre_snapshot().';

-- 2. dre_dados(): mesma permissao de antes, mas o "nao" vira ERRO ----------
-- Devolver {"erro":"sem_acesso"} como payload foi o que permitiu gravar a
-- recusa no lugar do DRE. Excecao nao entra em cache.
create or replace function public.dre_dados(p_ano integer)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if lower(coalesce(auth.jwt() ->> 'email','')) <> 'amanda.seibel@aelbra.com.br' then
    raise exception 'Acesso negado: o DRE e exclusivo da gerencia.' using errcode = '42501';
  end if;
  return public._dre_dados_calcula(p_ano);
end; $$;

-- 3. LEITURA: nunca servir nem gravar snapshot sem 'meses' ------------------
create or replace function public.dre_snapshot(p_ano integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_payload jsonb;
begin
  if not public.snapshot_gerencial_pode_ler() then raise exception 'Sem permissão.'; end if;
  select payload into v_payload from public.snapshot_gerencial where chave='dre' and ano=p_ano;
  -- "sem 'meses'" cobre o snapshot nulo (1a vez) e o envenenado que ficou de
  -- antes desta migration. Nos dois casos: recalcula.
  if v_payload is null or not (v_payload ? 'meses') then
    v_payload := public._dre_dados_calcula(p_ano);
    if v_payload ? 'meses' then
      insert into public.snapshot_gerencial(chave, ano, payload, gerado_por) values ('dre', p_ano, v_payload, 'bootstrap')
        on conflict (chave, ano) do update set payload=excluded.payload, gerado_em=now();
    end if;
  end if;
  return v_payload;
end; $$;

-- 4. REFRESH: idem, e um payload ruim nunca sobrescreve um bom --------------
create or replace function public.atualizar_snapshots_gerenciais(p_ano int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ano int := coalesce(p_ano, extract(year from now())::int);
        v_email text := coalesce(auth.jwt() ->> 'email','server');
        v_dre jsonb;
begin
  if not public.snapshot_gerencial_e_gestao() then raise exception 'Sem permissão para atualizar os snapshots gerenciais.'; end if;

  insert into public.snapshot_gerencial(chave, ano, payload, gerado_por, gerado_em)
    values ('executivo', 0, public.dashboard_executivo()::jsonb, v_email, now())
    on conflict (chave, ano) do update set payload=excluded.payload, gerado_por=excluded.gerado_por, gerado_em=now();

  -- Calcula com a autoridade da funcao, nao com a de quem clicou: a Fernanda
  -- pode mandar atualizar sem que o DRE dela venha vazio e apague o da Amanda.
  v_dre := public._dre_dados_calcula(v_ano);
  if v_dre ? 'meses' then
    insert into public.snapshot_gerencial(chave, ano, payload, gerado_por, gerado_em)
      values ('dre', v_ano, v_dre, v_email, now())
      on conflict (chave, ano) do update set payload=excluded.payload, gerado_por=excluded.gerado_por, gerado_em=now();
  end if;

  return jsonb_build_object('ok', true, 'ano', v_ano, 'gerado_em', now());
end; $$;

-- 5. Conserta o que ja estava envenenado -----------------------------------
update public.snapshot_gerencial s
   set payload = public._dre_dados_calcula(s.ano),
       gerado_por = 'reparo_20260903',
       gerado_em = now()
 where s.chave = 'dre'
   and not (s.payload ? 'meses');

commit;
