-- =============================================================================
-- PREVENTIVO — visão geral por período acadêmico, mudanças de valor entre
-- remessas e histórico do aluno
-- =============================================================================
--
-- ACRESCENTA três RPCs de LEITURA. Não altera nenhuma função, tabela, gatilho
-- ou policy existente, e não escreve em nenhuma tabela: o Preventivo segue
-- isolado da cobrança (nenhuma leitura ou escrita fora do prefixo `prev_`).
--
-- O QUE ESTAS RPCs NUNCA FAZEM:
--   * chamar de "pago" um título que sumiu do relatório. Pagamento só é
--     confirmado com baixa comprovada no Prime — e hoje a API do Prime não
--     expõe situação do título (docs/integracoes/prime-mapa-fontes-verdade.md).
--     `pagos_confirmados` é, portanto, sempre zero, e o que sumiu aparece como
--     `saiu_da_base_a_conferir`.
--   * transferir aluno para a cobrança. Entrar na carteira ReATIVA é por
--     borderô, fora daqui; passar de 31 dias muda só `prev_titulo.status`.
--   * identificar aluno por nome. A busca do histórico é por matrícula ou CPF
--     exatos.
--
-- PERÍODO ACADÊMICO: semestre pelo vencimento de ORIGEM do título (a
-- competência da mensalidade): janeiro–junho = `AAAA/1`, julho–dezembro =
-- `AAAA/2`. É uma convenção do Preventivo, não um dado do Prime.
--
-- Acesso: `preventivo_e_gestao()` no começo de cada RPC, como as demais.
-- Reversão: supabase/rollbacks/20261112120000_preventivo_visao_geral_historico.rollback.sql
-- =============================================================================

create or replace function public.preventivo_periodo_academico(p_data date)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select case when p_data is null then null
              else extract(year from p_data)::int::text || '/' ||
                   case when extract(month from p_data) <= 6 then '1' else '2' end
         end
$$;

comment on function public.preventivo_periodo_academico(date) is
  'Semestre acadêmico pela data: jan–jun = AAAA/1, jul–dez = AAAA/2. Convenção do Preventivo.';

-- -----------------------------------------------------------------------------
-- 1. VISÃO GERAL — a última remessa confirmada de cada carteira
-- -----------------------------------------------------------------------------
create or replace function public.preventivo_visao_geral(p_periodo text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_hoje date := public.preventivo_hoje();
  v jsonb;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;

  with ultima as (          -- a remessa mais recente (ordem canônica) de cada carteira
    select distinct on (l.carteira_id) l.carteira_id, l.id as lote_id
      from public.prev_lote l
     where l.status = 'CONFIRMADO'
     order by l.carteira_id,
              public.preventivo_ordem(l.extraido_em, l.extraido_precisao, l.ordem_no_dia, l.criado_em, l.id) desc
  ), na_ultima as (
    select t.id, t.carteira_id, t.matricula_prime, tl.saldo_na_remessa as valor, t.vencimento,
           public.preventivo_periodo_academico(coalesce(t.vencimento_origem, t.vencimento)) as periodo
      from ultima u
      join public.prev_titulo_lote tl on tl.lote_id = u.lote_id
      join public.prev_titulo t on t.id = tl.titulo_id
  ), ja_vista as (          -- títulos que apareceram em alguma remessa e não estão na última
    select t.id, t.matricula_prime,
           public.preventivo_periodo_academico(coalesce(t.vencimento_origem, t.vencimento)) as periodo,
           (select tl.saldo_na_remessa
              from public.prev_titulo_lote tl
              join public.prev_lote l on l.id = tl.lote_id and l.status = 'CONFIRMADO'
             where tl.titulo_id = t.id
             order by public.preventivo_ordem(l.extraido_em, l.extraido_precisao, l.ordem_no_dia, l.criado_em, l.id) desc
             limit 1) as ultimo_valor
      from public.prev_titulo t
      join ultima u on u.carteira_id = t.carteira_id
     where not exists (select 1 from na_ultima n where n.id = t.id)
       and exists (select 1 from public.prev_titulo_lote tl
                     join public.prev_lote l on l.id = tl.lote_id and l.status = 'CONFIRMADO'
                    where tl.titulo_id = t.id)
  ), periodos as (
    select periodo from na_ultima where periodo is not null
    union select periodo from ja_vista where periodo is not null
  ), f_n as (select * from na_ultima where p_periodo is null or periodo = p_periodo),
     f_s as (select * from ja_vista  where p_periodo is null or periodo = p_periodo),
     por_aluno as (
       select matricula_prime, bool_or(vencimento < v_hoje) as tem_vencido
         from f_n group by matricula_prime)
  select jsonb_build_object(
    'periodo', p_periodo,
    'periodos_disponiveis', coalesce((select jsonb_agg(periodo order by periodo desc) from periodos), '[]'::jsonb),
    'hoje', v_hoje,
    'matriculados',  (select count(*) from por_aluno),
    'inadimplentes', (select count(*) from por_aluno where tem_vencido),
    'adimplentes',   (select count(*) from por_aluno where not tem_vencido),
    'a_vencer', jsonb_build_object(
      'titulos', (select count(*) from f_n where vencimento >= v_hoje),
      'valor',   (select coalesce(sum(valor), 0) from f_n where vencimento >= v_hoje)),
    'vencidos', jsonb_build_object(
      'titulos', (select count(*) from f_n where vencimento < v_hoje),
      'valor',   (select coalesce(sum(valor), 0) from f_n where vencimento < v_hoje)),
    'pagos_confirmados', jsonb_build_object(
      'titulos', 0, 'valor', 0,
      'motivo', 'Pagamento só é confirmado com baixa comprovada no Prime, e a API do Prime não expõe situação do título. Nada é contado como pago por ter saído do relatório.'),
    'saiu_da_base_a_conferir', jsonb_build_object(
      'titulos', (select count(*) from f_s),
      'valor',   (select coalesce(sum(ultimo_valor), 0) from f_s),
      'definicao', 'Estava em remessa anterior e não aparece na mais recente. Pode ser pagamento, cancelamento, renegociação, bolsa ou mudança do recorte do relatório: conferir no Prime.')
  ) into v;
  return v;
end;
$$;

comment on function public.preventivo_visao_geral(text) is
  'Painel executivo do Preventivo: alunos e valores da última remessa de cada carteira, filtráveis por semestre (AAAA/N). Pago confirmado é sempre 0 sem baixa comprovada no Prime. Somente gestão.';

-- -----------------------------------------------------------------------------
-- 2. MUDANÇAS DE VALOR entre a remessa e a anterior (o "mudaram")
-- -----------------------------------------------------------------------------
create or replace function public.preventivo_remessa_mudancas(p_lote_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_carteira uuid; v_em timestamptz; v_prec text; v_ordem int; v_criado timestamptz;
  v_chave public.preventivo_ordem_remessa; v_ant uuid;
  v_ant_em timestamptz; v_ant_prec text; v_ant_ordem int; v jsonb;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select carteira_id, extraido_em, extraido_precisao, ordem_no_dia, criado_em
    into v_carteira, v_em, v_prec, v_ordem, v_criado
    from public.prev_lote where id = p_lote_id;
  if v_carteira is null then
    raise exception 'Remessa não encontrada.' using errcode = '22023';
  end if;
  v_chave := public.preventivo_ordem(v_em, v_prec, v_ordem, v_criado, p_lote_id);

  select l.id into v_ant from public.prev_lote l
   where l.carteira_id = v_carteira and l.status = 'CONFIRMADO'
     and public.preventivo_ordem(l.extraido_em, l.extraido_precisao, l.ordem_no_dia, l.criado_em, l.id) < v_chave
   order by public.preventivo_ordem(l.extraido_em, l.extraido_precisao, l.ordem_no_dia, l.criado_em, l.id) desc
   limit 1;
  if v_ant is null then
    return jsonb_build_object('remessa', p_lote_id, 'primeira_remessa', true, 'mudaram', '[]'::jsonb);
  end if;

  select extraido_em, extraido_precisao, ordem_no_dia into v_ant_em, v_ant_prec, v_ant_ordem
    from public.prev_lote where id = v_ant;
  if not public.preventivo_sequencia_comprovada(v_ant_em, v_ant_prec, v_ant_ordem, v_em, v_prec, v_ordem) then
    return jsonb_build_object('remessa', p_lote_id, 'remessa_anterior', v_ant,
      'sequencia_nao_comprovada', true, 'mudaram', null,
      'observacao', 'Sem como provar qual remessa veio primeiro: a comparação de valores não vale.');
  end if;

  select jsonb_build_object(
    'remessa', p_lote_id, 'remessa_anterior', v_ant,
    'primeira_remessa', false, 'sequencia_nao_comprovada', false,
    'mudaram', coalesce(jsonb_agg(jsonb_build_object(
        'titulo_id', t.id, 'matricula', t.matricula_prime, 'aluno_nome', t.aluno_nome,
        'documento', t.documento, 'valor_anterior', a.saldo_na_remessa,
        'valor_atual', n.saldo_na_remessa, 'delta', n.saldo_na_remessa - a.saldo_na_remessa)
      order by t.matricula_prime), '[]'::jsonb))
  into v
  from public.prev_titulo_lote n
  join public.prev_titulo_lote a on a.titulo_id = n.titulo_id and a.lote_id = v_ant
  join public.prev_titulo t on t.id = n.titulo_id
  where n.lote_id = p_lote_id
    and n.saldo_na_remessa is distinct from a.saldo_na_remessa;
  return v;
end;
$$;

comment on function public.preventivo_remessa_mudancas(uuid) is
  'Títulos presentes nas duas remessas consecutivas cujo valor mudou. Complementa preventivo_remessa_comparar (entraram/permaneceram/saíram). Somente gestão.';

-- -----------------------------------------------------------------------------
-- 3. HISTÓRICO DO ALUNO — por matrícula ou CPF exatos, nunca por nome
-- -----------------------------------------------------------------------------
create or replace function public.preventivo_aluno_historico(p_busca text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_txt text := nullif(trim(coalesce(p_busca, '')), '');
  v_dig text := nullif(regexp_replace(coalesce(p_busca, ''), '\D', '', 'g'), '');
  v_hoje date := public.preventivo_hoje();
  v jsonb;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  if v_txt is null then
    return jsonb_build_object('titulos', '[]'::jsonb);
  end if;

  with alvo as (
    select t.* from public.prev_titulo t
     where t.matricula_prime = v_txt
        or (v_dig is not null and length(v_dig) = 11 and t.cpf = v_dig)
  ), ultima as (
    select distinct on (l.carteira_id) l.carteira_id, l.id as lote_id
      from public.prev_lote l where l.status = 'CONFIRMADO'
     order by l.carteira_id,
              public.preventivo_ordem(l.extraido_em, l.extraido_precisao, l.ordem_no_dia, l.criado_em, l.id) desc
  )
  select jsonb_build_object(
    'busca', v_txt,
    'titulos', coalesce(jsonb_agg(jsonb_build_object(
      'titulo_id', a.id,
      'matricula', a.matricula_prime, 'aluno_nome', a.aluno_nome,
      'documento', a.documento, 'vencimento', a.vencimento,
      'vencimento_origem', a.vencimento_origem,
      'periodo_academico', public.preventivo_periodo_academico(coalesce(a.vencimento_origem, a.vencimento)),
      'valor_original', a.valor_original, 'status', a.status,
      'na_ultima_remessa', exists (select 1 from ultima u
                                    join public.prev_titulo_lote x on x.lote_id = u.lote_id
                                   where u.carteira_id = a.carteira_id and x.titulo_id = a.id),
      'dias_atraso', greatest(v_hoje - a.vencimento, 0),
      'remessas', (select coalesce(jsonb_agg(jsonb_build_object(
                      'remessa', l.nome, 'extraido_em', l.extraido_em,
                      'saldo', tl.saldo_na_remessa)
                    order by public.preventivo_ordem(l.extraido_em, l.extraido_precisao, l.ordem_no_dia, l.criado_em, l.id)),
                    '[]'::jsonb)
                     from public.prev_titulo_lote tl
                     join public.prev_lote l on l.id = tl.lote_id and l.status = 'CONFIRMADO'
                    where tl.titulo_id = a.id)
    ) order by a.vencimento), '[]'::jsonb))
  into v from alvo a;
  return v;
end;
$$;

comment on function public.preventivo_aluno_historico(text) is
  'Linha do tempo por título do aluno (matrícula ou CPF de 11 dígitos, exatos): vencimento, valor, presença em cada remessa. O histórico permanece depois que o título deixa a base ou passa de 31 dias. Somente gestão.';

revoke all on function public.preventivo_periodo_academico(date)    from public, anon;
revoke all on function public.preventivo_visao_geral(text)          from public, anon;
revoke all on function public.preventivo_remessa_mudancas(uuid)     from public, anon;
revoke all on function public.preventivo_aluno_historico(text)      from public, anon;
grant execute on function public.preventivo_periodo_academico(date) to authenticated, service_role;
grant execute on function public.preventivo_visao_geral(text)       to authenticated, service_role;
grant execute on function public.preventivo_remessa_mudancas(uuid)  to authenticated, service_role;
grant execute on function public.preventivo_aluno_historico(text)   to authenticated, service_role;
