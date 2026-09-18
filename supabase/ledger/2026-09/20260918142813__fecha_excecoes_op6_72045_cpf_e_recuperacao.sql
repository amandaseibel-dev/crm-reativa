-- FECHAMENTO DAS EXCECOES HUMANAS -- 18/09/2026 -- OPERACAO 6 -- pagamento 72045
-- Autorizado pela Amanda em 18/09/2026. A ficha correta (Normelio Augusto
-- Bitello) estava sem CPF; o CPF vem da propria mensalidade 4478507 e e o mesmo
-- que o Prime da para a matricula 221000402. Depois: a recuperacao automatica
-- oficial (acordo_avista_recuperar_um) so para este pagamento -- a previa
-- decide, o registrador grava, o motor baixa.
-- Backup: _backup_fecha_pagamentos_20260918 (op6_72045).
do $op$
declare
  c_aluno constant uuid := 'd2251ae8-080b-4e13-ac20-6f670b949a80';
  c_pid constant uuid := 'd3379c42-2af0-4d95-afbe-6334535a8974';
  v_cpf text; v_prime text; v_r jsonb; v_acordo uuid; v_n int;
begin
  -- RECONFIRMACAO: nome, matricula, CPF, titulo, aluno_id
  select lpad(regexp_replace(t.cpf,'\D','','g'),11,'0') into v_cpf
    from public.acordos_titulos t
   where t.aluno_id = c_aluno and t.documento = '4478507' and upper(t.situacao) = 'ABERTO' and t.acordo_id is null;
  select min(lpad(regexp_replace(cpf,'\D','','g'),11,'0')) into v_prime from public.prime_contratos where registration = '221000402';
  if v_cpf is null or v_prime is null or v_cpf <> v_prime
     or (select count(distinct lpad(regexp_replace(cpf,'\D','','g'),11,'0')) from public.prime_contratos where registration = '221000402') <> 1 then
    raise exception 'OP6_ABORTADA: CPF do titulo e do Prime nao conferem';
  end if;
  if not exists (select 1 from public.alunos where id = c_aluno and nome = 'Normélio Augusto Bitello' and coalesce(regexp_replace(cpf,'\D','','g'),'') = '') then
    raise exception 'OP6_ABORTADA: a ficha mudou (nome ou CPF ja preenchido)';
  end if;
  if exists (select 1 from public.alunos where lpad(regexp_replace(coalesce(cpf,''),'\D','','g'),11,'0') = v_cpf) then
    raise exception 'OP6_ABORTADA: ja existe ficha com este CPF';
  end if;
  if (select count(*) from public.alunos where nome ilike 'norm_lio augusto bitello') <> 1 then
    raise exception 'OP6_ABORTADA: o nome deixou de ser unico';
  end if;
  if not exists (select 1 from public.pagamentos p join public.fila_pagamento_sem_vinculo f on f.pagamento_id = p.id and f.decisao is null
                  where p.id = c_pid and p.status_conciliacao = 'AGUARDANDO_ACORDO' and p.matricula = '221000402'
                    and p.aluno_nome = 'Normélio Augusto Bitello' and p.aluno_id = c_aluno) then
    raise exception 'OP6_ABORTADA: o pagamento 72045 nao esta como lido';
  end if;

  insert into public._backup_fecha_pagamentos_20260918 (op, tabela, registro_id, antes)
  select 'op6_72045', 'alunos', a.id, to_jsonb(a) from public.alunos a where a.id = c_aluno
  union all select 'op6_72045', 'fila_pagamento_sem_vinculo', f.pagamento_id, to_jsonb(f) from public.fila_pagamento_sem_vinculo f where f.pagamento_id = c_pid;

  update public.alunos
     set cpf = v_cpf,
         observacao = coalesce(nullif(btrim(observacao),'') || ' | ', '')
           || '18/09/2026: CPF preenchido pela mensalidade 4478507 e pelo Prime (matricula 221000402); autorizado pela Amanda.'
   where id = c_aluno;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('fechamento_pagamentos_20260918', 'CPF_PREENCHIDO_PELA_MENSALIDADE', 'alunos', c_aluno,
          jsonb_build_object('op', 6, 'pagamento', '72045', 'fonte', jsonb_build_array('acordos_titulos 4478507', 'prime_contratos 221000402'),
                             'autorizado_por', 'amanda.seibel@aelbra.com.br'));

  -- a recuperacao automatica oficial, so para este pagamento
  v_r := public.acordo_avista_recuperar_um(c_pid, true);
  if not coalesce((v_r->>'gravou')::boolean, false) then
    raise exception 'OP6_ABORTADA: a previa/registrador recusou: %', v_r;
  end if;

  -- VALIDACAO FINAL
  select q.acordo_id into v_acordo from public.parcelas q where q.origem_baixa_ref = c_pid::text and upper(q.status) = 'PAGO';
  if v_acordo is null
     or (select status_conciliacao from public.pagamentos where id = c_pid) <> 'BAIXADO'
     or (select upper(status) from public.acordos where id = v_acordo) <> 'QUITADO'
     or (select numero_ulbra from public.acordos where id = v_acordo) <> '72045'
     or (select count(*) from public.acordos where numero_ulbra = '72045') <> 1
     or not exists (select 1 from public.acordos_titulos t join public.acordo_titulo_vinculo v on v.titulo_id = t.id and v.acordo_id = v_acordo and v.ativo
                     where t.documento = '4478507' and upper(t.situacao) = 'PAGO' and t.acordo_id = v_acordo) then
    raise exception 'OP6_ABORTADA: a cadeia final nao fechou';
  end if;
  select count(*) into v_n from public.parcelas where origem_baixa_ref = c_pid::text;
  if v_n <> 1 then raise exception 'OP6_ABORTADA: pagamento em % parcelas', v_n; end if;
end
$op$;
