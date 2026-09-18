-- CONFERENCIA PRIME -- classe C1 apos a reversao da auditoria: vinculo oficial ao acordo existente e comprovadamente correspondente.
-- Unico caso que passa na prova estrita: aluno 1541ce87, titulos 4313444/45/46 (R$ 1.539,77, liquidados na Prime em 14/08).
-- Prova: o pagamento ReATIVA de 14/08 (boleto 50636880001, R$ 563,18) e a entrada do acordo Prime 063688; o acordo 3724 do CRM
-- tem numero_ulbra 63688, e do mesmo aluno, esta ATIVO (parcelas 2 a 6, 5 x R$ 262,81) e nao tem vinculo nenhum.
-- Acordo ATIVO -> titulos NEGOCIADO. Nenhum acordo, parcela ou pagamento novo.
do $c1$
declare
  c_acordo constant uuid := '3972e708-3cf4-4ffc-bc55-9c3da3ba22a6';
  c_aluno  constant uuid := '1541ce87-9694-432e-8a03-da4a2ff01c13';
  c_tits   constant uuid[] := array['b1e921c3-a8a5-4228-ad99-5d4ccb6598be','331ed5bb-a470-41b0-9205-8638ccfa968c','66c9f13e-2188-455c-9cd6-6add7ff6fdb0']::uuid[];
  c_mot    constant text := 'C1 apos AUDITORIA_GRUPO_A_EVIDENCIA_INSUFICIENTE (gestao 18/09/2026): o pagamento ReATIVA de 14/08 (boleto 50636880001) '
                            || 'e a entrada do acordo Prime 063688 = acordo 3724 do CRM; os titulos foram liquidados na Prime nesse mesmo dia pela '
                            || 'renegociacao. Acordo ATIVO: a divida fica nas parcelas do acordo.';
  t uuid; v_res jsonb; v_n int; v_sit text; v_resp text; v_saldo numeric;
  v_a0 bigint; v_p0 bigint; v_g0 bigint; v_v0 bigint;
begin
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'vincular_titulos_acordo') <> 'd857ce1e53b4f5aea87ee49f7e92406f' then
    raise exception 'C1_PRE: vincular_titulos_acordo mudou';
  end if;
  if not exists (select 1 from public.acordos a where a.id = c_acordo and a.aluno_id = c_aluno and a.status = 'ATIVO' and ltrim(a.numero_ulbra,'0') = '63688')
     or exists (select 1 from public.acordo_titulo_vinculo v where v.acordo_id = c_acordo and coalesce(v.ativo, true)) then
    raise exception 'C1_PRE: acordo 3724 fora do estado conferido';
  end if;
  if not exists (select 1 from public.pagamentos p where ltrim(p.numero_parcela_completo,'0') = '50636880001' and p.aluno_id = c_aluno and p.data_pagamento = '2026-08-14') then
    raise exception 'C1_PRE: pagamento da entrada nao confere';
  end if;
  select count(*) into v_n from public.acordos_titulos t join public.prime_conferencia_decisao d on d.titulo_id = t.id
   where t.id = any(c_tits) and t.aluno_id = c_aluno and t.situacao = 'EM_CONFIRMACAO' and d.decisao = 'PENDENTE'
     and (d.evidencia ->> 'liquidado_em')::date = '2026-08-14' and d.evidencia -> 'reaberta_por_auditoria' ->> 'classe' = 'C_parcial'
     and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo, true));
  if v_n <> 3 then raise exception 'C1_PRE: so % de 3 titulos no estado esperado', v_n; end if;

  select situacao_operacional, lower(responsavel_atual_email) into v_sit, v_resp from public.alunos where id = c_aluno;
  select count(*) into v_a0 from public.acordos;
  select count(*) into v_p0 from public.parcelas;
  select count(*) into v_g0 from public.pagamentos;
  select count(*) into v_v0 from public.acordo_titulo_vinculo where coalesce(ativo, true);

  perform set_config('request.jwt.claims', '{"email":"amanda.seibel@aelbra.com.br","sub":"52b292e4-e43e-4200-a684-b63d889d273a","role":"authenticated"}', true);
  foreach t in array c_tits loop
    v_res := public.prime_conferencia_vincular(t, c_acordo, c_mot);
    if coalesce(v_res ->> 'decisao','') <> 'VINCULADO' or coalesce(v_res ->> 'acordo_numero','') <> '3724' then
      raise exception 'C1: vinculo do titulo % falhou (%)', t, v_res;
    end if;
  end loop;

  select count(*) into v_n from public.acordos_titulos t join public.prime_conferencia_decisao d on d.titulo_id = t.id
   where t.id = any(c_tits) and t.situacao = 'NEGOCIADO' and t.status = 'vinculada' and t.acordo_id = c_acordo
     and t.origem_liquidacao is null and d.decisao = 'VINCULADO'
     and (select count(*) from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo, true)) = 1;
  if v_n <> 3 then raise exception 'C1_POS: so % de 3 titulos NEGOCIADO no acordo 3724', v_n; end if;
  if (select status from public.acordos where id = c_acordo) <> 'ATIVO' then raise exception 'C1_POS: acordo mudou de status'; end if;
  if (select count(*) from public.acordos) <> v_a0 or (select count(*) from public.parcelas) <> v_p0
     or (select count(*) from public.pagamentos) <> v_g0 then
    raise exception 'C1_POS: acordo, parcela ou pagamento criado';
  end if;
  if (select count(*) from public.acordo_titulo_vinculo where coalesce(ativo, true)) <> v_v0 + 3 then raise exception 'C1_POS: vinculos != +3'; end if;
  if (select situacao_operacional from public.alunos where id = c_aluno) is distinct from v_sit
     or (select lower(responsavel_atual_email) from public.alunos where id = c_aluno) is distinct from v_resp then
    raise exception 'C1_POS: situacao ou responsavel do aluno mudou';
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'CONFERENCIA_PRIME_AUDITORIA_A1_C1_VINCULO', 'prime_conferencia_decisao', c_acordo,
          jsonb_build_object('aluno_id', c_aluno, 'acordo_numero', 3724, 'acordo_prime', '063688', 'titulo_ids', to_jsonb(c_tits),
                             'valor', 1539.77, 'prova', 'pagamento 50636880001 de 14/08 = entrada do acordo 063688; liquidacao Prime no mesmo dia',
                             'resultado', 'NEGOCIADO no acordo ATIVO 3724'));
end;
$c1$;
