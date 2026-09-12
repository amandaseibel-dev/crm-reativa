-- ITEM 5. Rastreabilidade prospectiva de COMO pagamentos.aluno_id foi decidido.
--
-- Equivalente exato do que parcelas.origem_baixa faz para a baixa. Hoje, depois
-- que o gatilho roda, nao existe forma de saber qual etapa venceu: a etapa tem
-- de ser RECALCULADA, e recalculo nao e registro -- se a regra mudar amanha, a
-- reconstrucao passa a mentir sobre o passado.
--
-- PROSPECTIVO, e so isso. Os 8.999 pagamentos historicos ficam com NULL, de
-- propositio: preencher por inferencia seria inventar prova. O CHECK aceita NULL
-- exatamente para isso.

alter table public.pagamentos
  add column if not exists origem_vinculo     text,
  add column if not exists origem_vinculo_ref text,
  add column if not exists origem_vinculo_em  timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pagamentos_origem_vinculo_valida') then
    alter table public.pagamentos
      add constraint pagamentos_origem_vinculo_valida check (
        origem_vinculo is null or origem_vinculo in (
          'CPF',                 -- CPF da linha casou com alunos.cpf normalizado
          'BOLETO_EXATO',        -- parcelas.boleto e UNIQUE: isto e prova
          'PREFIXO_UNICO',       -- prefixo de 6 digitos apontou para 1 unico acordo
          'NUMERO_ULBRA_UNICO',  -- numero_ulbra unico
          'GESTAO_MANUAL',       -- decisao humana na fila
          'SEM_VINCULO'          -- nenhum identificador resolveu; foi para a fila
        )
      );
  end if;
end $$;

comment on column public.pagamentos.origem_vinculo is
  'Como aluno_id foi decidido. Prospectivo a partir de 12/09/2026 -- NULL no historico, de proposito. Nome NUNCA aparece aqui: nome nao vincula.';
comment on column public.pagamentos.origem_vinculo_ref is
  'A evidencia: o CPF, o boleto, o prefixo, o numero_ulbra, ou o e-mail de quem decidiu.';

create index if not exists ix_pagamentos_origem_vinculo
  on public.pagamentos (origem_vinculo) where origem_vinculo is not null;

-- ---------------------------------------------------------------------------
-- O gatilho passa a REGISTRAR a etapa que venceu, em vez de so vincular.
-- Logica identica a que esta em producao desde 20260912121224; a unica mudanca
-- e gravar origem_vinculo / _ref / _em em cada saida.
-- ---------------------------------------------------------------------------
create or replace function public._pagamento_vincula_por_identificador_financeiro()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_cpf text; v_pref text; v_id uuid; v_n int;
begin
  if new.aluno_id is not null then
    -- ja veio com aluno de fora do gatilho (ex.: RPC da gestao). Nao sobrescreve
    -- a origem que o chamador tenha gravado.
    if new.origem_vinculo is null then
      new.origem_vinculo := 'GESTAO_MANUAL';
      new.origem_vinculo_ref := coalesce(nullif(new.operador_email,''), 'informado na insercao');
      new.origem_vinculo_em := now();
    end if;
    return new;
  end if;

  new.origem_vinculo_em := now();

  -- 1) CPF confiavel: mesma expressao do indice idx_alunos_cpf_normalizado
  v_cpf := nullif(regexp_replace(coalesce(new.cpf,''), '\D', '', 'g'), '');
  if v_cpf is not null and length(v_cpf) between 10 and 11 then
    select a.id into v_id from public.alunos a
     where lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') = lpad(v_cpf, 11, '0')
     limit 1;
    if v_id is not null then
      new.aluno_id := v_id;
      new.origem_vinculo := 'CPF';
      new.origem_vinculo_ref := lpad(v_cpf, 11, '0');
      return new;
    end if;
  end if;

  if new.numero_parcela_completo is null then
    new.origem_vinculo := 'SEM_VINCULO';
    new.origem_vinculo_ref := 'sem CPF valido e sem numero de boleto na linha';
    return new;
  end if;

  -- 2) boleto exato: parcelas.boleto e UNIQUE, entao isto e prova
  select a.aluno_id into v_id
    from public.parcelas p join public.acordos a on a.id = p.acordo_id
   where p.boleto = new.numero_parcela_completo limit 1;
  if v_id is not null then
    new.aluno_id := v_id;
    new.origem_vinculo := 'BOLETO_EXATO';
    new.origem_vinculo_ref := new.numero_parcela_completo;
    return new;
  end if;

  -- 3) prefixo do boleto, SO se apontar para um unico acordo.
  if length(new.numero_parcela_completo) = 11 then
    v_pref := substring(new.numero_parcela_completo, 2, 6);

    select count(distinct p.acordo_id), min(a.aluno_id::text)::uuid into v_n, v_id
      from public.parcelas p join public.acordos a on a.id = p.acordo_id
     where p.boleto like '5' || v_pref || '%';
    if v_n = 1 and v_id is not null then
      new.aluno_id := v_id;
      new.origem_vinculo := 'PREFIXO_UNICO';
      new.origem_vinculo_ref := v_pref;
      return new;
    end if;

    -- 4) numero_ulbra, SO se unico
    select count(*), min(a.aluno_id::text)::uuid into v_n, v_id
      from public.acordos a
     where a.numero_ulbra is not null
       and lpad(a.numero_ulbra, 6, '0') = v_pref;
    if v_n = 1 and v_id is not null then
      new.aluno_id := v_id;
      new.origem_vinculo := 'NUMERO_ULBRA_UNICO';
      new.origem_vinculo_ref := v_pref;
      return new;
    end if;

    new.origem_vinculo := 'SEM_VINCULO';
    new.origem_vinculo_ref := 'prefixo ' || v_pref
      || ' nao resolveu: ' || coalesce(v_n, 0)::text || ' acordo(s) por numero_ulbra';
    return new;
  end if;

  new.origem_vinculo := 'SEM_VINCULO';
  new.origem_vinculo_ref := 'boleto fora do padrao de 11 digitos: ' || new.numero_parcela_completo;
  return new;
end;
$fn$;

revoke all on function public._pagamento_vincula_por_identificador_financeiro() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- A decisao humana tambem passa a deixar rastro: origem_vinculo = GESTAO_MANUAL
-- e a linha da fila e FECHADA (decisao, aluno escolhido, quem e quando). Hoje
-- essas colunas da fila existem e ninguem as preenche.
-- ---------------------------------------------------------------------------
create or replace function public.pagamento_vincular_aluno(
  p_pagamento_id uuid, p_aluno_id uuid, p_observacao text default null
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare v_nome text; v_cpf text; v_ant uuid; v_email text; v_fila int := 0;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Vincular pagamento a aluno e decisao da gestao.' using errcode = '42501';
  end if;

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao');

  select a.nome, a.cpf into v_nome, v_cpf from public.alunos a where a.id = p_aluno_id;
  if v_nome is null then
    return jsonb_build_object('ok', false, 'motivo', 'ALUNO_NAO_ENCONTRADO');
  end if;

  select aluno_id into v_ant from public.pagamentos where id = p_pagamento_id;

  update public.pagamentos
     set aluno_id = p_aluno_id,
         cpf = coalesce(cpf, v_cpf),
         origem_vinculo = 'GESTAO_MANUAL',
         origem_vinculo_ref = v_email,
         origem_vinculo_em = now()
   where id = p_pagamento_id;

  -- fecha a pendencia na fila, se existir. Historico de quem resolveu fica aqui
  -- E em aluno_movimentacoes -- um para auditar a fila, outro para a ficha.
  update public.fila_pagamento_sem_vinculo
     set decisao = 'VINCULADO',
         aluno_escolhido_id = p_aluno_id,
         decidido_por = v_email,
         decidido_em = now(),
         observacao = p_observacao
   where pagamento_id = p_pagamento_id and decisao is null;
  get diagnostics v_fila = row_count;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
  values (p_aluno_id::text, 'PAGAMENTO_VINCULADO',
          'Pagamento vinculado manualmente pela gestao.'
          || case when p_observacao is null then '' else ' ' || p_observacao end,
          v_email, v_email, now());

  return jsonb_build_object('ok', true, 'aluno_nome', v_nome,
                            'aluno_id_anterior', v_ant, 'fila_fechada', v_fila);
end;
$fn$;

grant execute on function public.pagamento_vincular_aluno(uuid, uuid, text) to authenticated;
revoke all on function public.pagamento_vincular_aluno(uuid, uuid, text) from public, anon;

-- PROVA
do $$
declare v_cols int; v_check boolean; v_hist int; v_trg boolean;
begin
  select count(*) into v_cols from information_schema.columns
   where table_schema='public' and table_name='pagamentos'
     and column_name in ('origem_vinculo','origem_vinculo_ref','origem_vinculo_em');
  if v_cols <> 3 then raise exception 'faltou coluna de origem_vinculo: % de 3', v_cols; end if;

  select true into v_check from pg_constraint where conname='pagamentos_origem_vinculo_valida';
  if not coalesce(v_check,false) then raise exception 'CHECK de origem_vinculo nao existe'; end if;

  -- historico NAO pode ter sido preenchido
  select count(*) into v_hist from public.pagamentos where origem_vinculo is not null;
  if v_hist <> 0 then
    raise exception 'origem_vinculo foi preenchido em % linhas historicas -- nao era o combinado', v_hist;
  end if;

  select p.prosrc like '%origem_vinculo%' into v_trg
    from pg_proc p where p.proname='_pagamento_vincula_por_identificador_financeiro';
  if not coalesce(v_trg,false) then raise exception 'gatilho nao grava origem_vinculo'; end if;

  raise notice 'origem_vinculo: 3 colunas, CHECK ativo, 0 linhas historicas tocadas, gatilho registrando';
end $$;
