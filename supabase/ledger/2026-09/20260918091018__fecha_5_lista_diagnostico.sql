-- FECHA OS 5. Remove de cobranca_nao_reabrir SOMENTE as 13 linhas semeadas a
-- partir do diagnostico de 10/09 com status_acionamento = CANCELADO na lista, e
-- roda a reabertura controlada. Uma transacao so: qualquer conferencia que
-- falhar desfaz tudo, inclusive os backups.

-- 1. As 13 linhas, guardadas antes de sair.
create table public._backup_cobranca_nao_reabrir_13_20260918 as
select nr.*, now() as capturado_em
  from public.cobranca_nao_reabrir nr
 where nr.origem = '_cancelamento_cobranca_20260910'
   and nr.registrado_por = 'migracao_20260918000000'
   and exists (select 1 from public._cancelamento_cobranca_20260910 x
                where lpad(regexp_replace(coalesce(x.cpf,''), '\D', '', 'g'), 11, '0') = nr.cpf
                  and upper(coalesce(x.status_acionamento,'')) = 'CANCELADO');
alter table public._backup_cobranca_nao_reabrir_13_20260918 enable row level security;

-- 2. Estado de caso e aluno ANTES da reabertura (status anterior preservado).
create table public._backup_reabertura_5_lista_20260918 as
select c.id as caso_id, c.aluno_id, c.cpf_limpo, c.nome,
       c.operador_email, c.operador_nome,
       c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada,
       c.situacao_operacional, c.nao_acionar, c.encerrado_operacional,
       c.caso_atualizado_por, c.caso_atualizado_em,
       a.status_atual  as aluno_status_atual,
       a.status_jornada as aluno_status_jornada,
       a.status_acionamento as aluno_status_acionamento,
       a.responsavel_atual_email, a.responsavel_atual_nome,
       a.saldo_total as aluno_saldo_total,
       now() as capturado_em
  from public.casos c
  join public.alunos a on a.id = c.aluno_id
 where lpad(regexp_replace(coalesce(c.cpf_limpo,''), '\D', '', 'g'), 11, '0')
       in (select cpf from public._backup_cobranca_nao_reabrir_13_20260918);
alter table public._backup_reabertura_5_lista_20260918 enable row level security;

do $$
declare
  v_esperados uuid[] := array['6a9ea543-0dbf-4f97-abfe-684c2213e427',
                              'e93150f7-8173-4b22-9d5f-9aed3b857b44',
                              'e3c7fafd-ed05-4706-a057-694c935cb158',
                              '23156986-f34c-44a2-86df-2f6090d3db4e',
                              'e536f65b-3f39-45ba-81d2-1a651d692576']::uuid[];
  v_n13 int; v_del int; v_antes int; v_n int; v_depois int; v_reabertos uuid[];
begin
  select count(*) into v_n13 from public._backup_cobranca_nao_reabrir_13_20260918;
  if v_n13 <> 13 then
    raise exception 'esperava 13 linhas a remover, achei %', v_n13;
  end if;
  if exists (select 1 from public._backup_cobranca_nao_reabrir_13_20260918
              where motivo <> 'Cancelamento de cobranca') then
    raise exception 'uma das 13 linhas nao e "Cancelamento de cobranca"';
  end if;

  -- Nenhum dos 5 pode ter decisao explicita de nao cobrar.
  if exists (select 1 from public.casos where aluno_id = any(v_esperados) and nao_acionar is true) then
    raise exception 'um dos 5 tem nao_acionar = true';
  end if;
  if exists (select 1 from public.alunos where id = any(v_esperados)
              and upper(coalesce(status_atual,'')) ~ 'JURIDICO|CANCELAMENTO|SUSPENSAO') then
    raise exception 'um dos 5 esta JURIDICO/CANCELAMENTO/SUSPENSAO no aluno';
  end if;
  if exists (select 1 from public.aluno_movimentacoes m
              where m.aluno_id = any(v_esperados::text[])
                and m.registrado_por_email like '%@%' and m.registrado_por_email not like 'sistema%'
                and (upper(coalesce(m.status_novo,'')) ~ 'CANCEL|SUSPENS'
                     or upper(coalesce(m.tipo,'')) ~ 'CANCEL|SUSPENS')) then
    raise exception 'um dos 5 tem cancelamento/suspensao registrado por pessoa';
  end if;

  delete from public.cobranca_nao_reabrir nr
   using public._backup_cobranca_nao_reabrir_13_20260918 b
   where nr.cpf = b.cpf;
  get diagnostics v_del = row_count;
  if v_del <> 13 then
    raise exception 'removeria % linhas, esperado 13', v_del;
  end if;

  select count(*) into v_antes from public.casos where encerrado_operacional = false;
  v_n := public.casos_reabrir_com_divida();
  select count(*) into v_depois from public.casos where encerrado_operacional = false;

  -- now() e fixo na transacao: pega exatamente as movimentacoes desta rodada.
  select array_agg(distinct m.aluno_id::uuid order by m.aluno_id::uuid) into v_reabertos
    from public.aluno_movimentacoes m
   where m.tipo = 'REABERTURA_DIVIDA_NOVA'
     and m.registrado_por_email = 'sistema_reabrir_com_divida'
     and m.registrado_em = now();

  if v_n <> 5 or v_depois - v_antes <> 5
     or v_reabertos is distinct from (select array_agg(x order by x) from unnest(v_esperados) x) then
    raise exception 'reabertura fora do esperado: n=% antes=% depois=% reabertos=%',
      v_n, v_antes, v_depois, v_reabertos;
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
  values ('migracao_20260918_fecha_5', 'REABERTURA_CONTROLADA_5_LISTA_DIAGNOSTICO', 'casos',
          jsonb_build_object('linhas_removidas_cobranca_nao_reabrir', v_del,
                             'casos_ativos_antes', v_antes, 'reabertos', v_n,
                             'casos_ativos_depois', v_depois,
                             'alunos', to_jsonb(v_reabertos), 'em', now()));
end $$;
