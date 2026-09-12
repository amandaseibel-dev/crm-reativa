-- Tira da DISTRIBUICAO AUTOMATICA os 3 casos cuja divida o Prime ja registra
-- como liquidada, pendentes da futura conciliacao Prime x CRM.
--
-- Usa a protecao operacional que JA existe: `casos.nao_acionar`. Ela e a
-- primeira linha de `caso_protegido_redistribuicao()`, com curto-circuito:
--     if coalesce(p_nao_acionar, false) then return true; end if;
-- Os quatro mecanismos de captura/distribuicao passam por esse mesmo portao:
-- reposicao_carteira_processar, nivelamento_automatico_gestao,
-- trg_repor_caso_operador e trg_impor_teto_operador.
--
-- Sem status novo, sem coluna nova, sem mudanca de codigo. NENHUMA baixa,
-- NENHUMA conciliacao: titulo, acordo, parcela e pagamento nao sao tocados.
-- A divida dos tres (R$ 1.849,92) CONTINUA no saldo -- tirar do saldo e
-- conciliacao financeira, que e outra fase.
--
-- Tudo numa transacao: se qualquer verificacao falhar, nada e aplicado.

-- 1. Backup do estado anterior. E tambem a fonte do rollback.
create table if not exists public._backup_excecao_conciliacao_20260912 as
select c.id as caso_id, c.caso_codigo, c.aluno_id,
       c.total_em_aberto            as total_em_aberto_antes,
       coalesce(c.nao_acionar,false) as nao_acionar_antes,
       c.observacao_operacional     as observacao_antes,
       c.caso_atualizado_por        as atualizado_por_antes,
       c.caso_atualizado_em         as atualizado_em_antes,
       c.operador_email             as operador_antes,
       al.saldo_total               as aluno_saldo_total_antes,
       now() as guardado_em
from public.casos c
join public.alunos al on al.id = c.aluno_id
where c.caso_codigo in (17138, 17148, 17155);

alter table public._backup_excecao_conciliacao_20260912 enable row level security;

-- 2. Tabela de prova, para conferir depois em leitura
create table if not exists public._excecao_conciliacao_prova_20260912 (
  verificacao text primary key,
  resultado   text,
  aferido_em  timestamptz not null default now()
);
alter table public._excecao_conciliacao_prova_20260912 enable row level security;

do $apl$
declare
  v_carteira_antes numeric; v_carteira_depois numeric;
  v_n_tit_antes bigint; v_n_pag_antes bigint; v_n_aco_antes bigint; v_n_par_antes bigint;
  v_md5_fin_antes text; v_md5_fin_depois text;
  v_alterados int; v_prot int; v_sem_op int; v_flag int;
begin
  if (select count(*) from public._backup_excecao_conciliacao_20260912) <> 3 then
    raise exception 'backup nao pegou exatamente 3 casos -- abortando';
  end if;

  select round(coalesce(sum(saldo_total),0),2) into v_carteira_antes from public.alunos;
  select count(*) into v_n_tit_antes from public.acordos_titulos;
  select count(*) into v_n_pag_antes from public.pagamentos;
  select count(*) into v_n_aco_antes from public.acordos;
  select count(*) into v_n_par_antes from public.parcelas;

  -- impressao digital do lado financeiro dos 3 alunos
  select md5(coalesce(string_agg(x.linha, '|' order by x.linha), '')) into v_md5_fin_antes
    from (
      select 'T'||t.id::text||t.situacao||t.status||coalesce(t.saldo_corrigido,0)::text as linha
        from public.acordos_titulos t
       where t.aluno_id in (select aluno_id from public._backup_excecao_conciliacao_20260912)
      union all
      select 'P'||p.id::text||p.status||coalesce(p.valor,0)::text||coalesce(p.pago_em::text,'-')
        from public.parcelas p join public.acordos a on a.id = p.acordo_id
       where a.aluno_id in (select aluno_id from public._backup_excecao_conciliacao_20260912)
      union all
      select 'G'||g.id::text||coalesce(g.valor_pago,0)::text
        from public.pagamentos g
       where g.aluno_id in (select aluno_id from public._backup_excecao_conciliacao_20260912)
      union all
      select 'A'||a.id::text||a.status||coalesce(a.saldo,0)::text
        from public.acordos a
       where a.aluno_id in (select aluno_id from public._backup_excecao_conciliacao_20260912)
    ) x;

  -- 3. O UPDATE, com as guardas pedidas
  with alterados as (
    update public.casos
       set nao_acionar = true,
           observacao_operacional =
             coalesce(nullif(observacao_operacional, '') || ' | ', '')
             || 'Fora da distribuicao em 12/09/2026: divida ja liquidada no Prime, pendente da conciliacao Prime x CRM. Reverter quando a conciliacao for concluida.',
           caso_atualizado_por = 'gestao_excecao_conciliacao',
           caso_atualizado_em = now()
     where caso_codigo in (17138, 17148, 17155)
       and operador_email is null
       and coalesce(nao_acionar, false) = false
    returning caso_codigo
  )
  select count(*) into v_alterados from alterados;

  -- 4. Verificacoes. Qualquer falha aborta a transacao inteira.
  if v_alterados <> 3 then
    raise exception 'esperava 3 casos alterados, alterou % -- abortando', v_alterados;
  end if;

  select count(*) into v_flag from public.casos
   where caso_codigo in (17138,17148,17155) and nao_acionar = true;
  if v_flag <> 3 then raise exception 'nao_acionar nao ficou true nos 3 (ficou em %)', v_flag; end if;

  select count(*) into v_sem_op from public.casos
   where caso_codigo in (17138,17148,17155) and operador_email is null;
  if v_sem_op <> 3 then raise exception 'algum caso ganhou operador -- abortando'; end if;

  if exists (select 1 from public.casos c
               join public._backup_excecao_conciliacao_20260912 b on b.caso_id = c.id
              where coalesce(c.total_em_aberto,-1) is distinct from coalesce(b.total_em_aberto_antes,-1)) then
    raise exception 'total_em_aberto mudou -- abortando';
  end if;

  if exists (select 1 from public.alunos al
               join public._backup_excecao_conciliacao_20260912 b on b.aluno_id = al.id
              where coalesce(al.saldo_total,-1) is distinct from coalesce(b.aluno_saldo_total_antes,-1)) then
    raise exception 'alunos.saldo_total mudou -- abortando';
  end if;

  select round(coalesce(sum(saldo_total),0),2) into v_carteira_depois from public.alunos;
  if v_carteira_depois <> v_carteira_antes then
    raise exception 'carteira global mudou: % -> % -- abortando', v_carteira_antes, v_carteira_depois;
  end if;

  if (select count(*) from public.acordos_titulos) <> v_n_tit_antes
     or (select count(*) from public.pagamentos) <> v_n_pag_antes
     or (select count(*) from public.acordos)    <> v_n_aco_antes
     or (select count(*) from public.parcelas)   <> v_n_par_antes then
    raise exception 'contagem de titulo/pagamento/acordo/parcela mudou -- abortando';
  end if;

  select md5(coalesce(string_agg(x.linha, '|' order by x.linha), '')) into v_md5_fin_depois
    from (
      select 'T'||t.id::text||t.situacao||t.status||coalesce(t.saldo_corrigido,0)::text as linha
        from public.acordos_titulos t
       where t.aluno_id in (select aluno_id from public._backup_excecao_conciliacao_20260912)
      union all
      select 'P'||p.id::text||p.status||coalesce(p.valor,0)::text||coalesce(p.pago_em::text,'-')
        from public.parcelas p join public.acordos a on a.id = p.acordo_id
       where a.aluno_id in (select aluno_id from public._backup_excecao_conciliacao_20260912)
      union all
      select 'G'||g.id::text||coalesce(g.valor_pago,0)::text
        from public.pagamentos g
       where g.aluno_id in (select aluno_id from public._backup_excecao_conciliacao_20260912)
      union all
      select 'A'||a.id::text||a.status||coalesce(a.saldo,0)::text
        from public.acordos a
       where a.aluno_id in (select aluno_id from public._backup_excecao_conciliacao_20260912)
    ) x;
  if v_md5_fin_depois is distinct from v_md5_fin_antes then
    raise exception 'lado financeiro dos 3 alunos mudou -- abortando';
  end if;

  -- 7. O portao tem que barrar os tres agora
  select count(*) into v_prot from public.casos c
   where c.caso_codigo in (17138,17148,17155)
     and public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
                                              c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado);
  if v_prot <> 3 then
    raise exception 'caso_protegido_redistribuicao nao devolveu true nos 3 (devolveu em %)', v_prot;
  end if;

  -- grava a prova
  insert into public._excecao_conciliacao_prova_20260912 (verificacao, resultado) values
    ('1. casos alterados',                          v_alterados::text || ' (esperado 3)'),
    ('2. nao_acionar = true nos tres',              v_flag::text || ' de 3'),
    ('3. continuam sem operador',                   v_sem_op::text || ' de 3'),
    ('4. total_em_aberto inalterado',               'OK - nenhuma divergencia contra o backup'),
    ('5. alunos.saldo_total inalterado',            'OK - nenhuma divergencia contra o backup'),
    ('5b. carteira global inalterada',              v_carteira_antes::text || ' -> ' || v_carteira_depois::text),
    ('6. titulo/pagamento/acordo/parcela',          'contagens iguais; md5 financeiro dos 3 alunos identico: ' || v_md5_fin_antes),
    ('7. caso_protegido_redistribuicao = true',     v_prot::text || ' de 3')
  on conflict (verificacao) do update set resultado = excluded.resultado, aferido_em = now();
end
$apl$;
