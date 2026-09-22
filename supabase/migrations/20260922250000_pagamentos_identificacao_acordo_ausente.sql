-- IDENTIFICACAO AUTOMATICA DO ALUNO EM PAGAMENTO SEM ACORDO NO CRM (AGUARDANDO_ACORDO).
--
-- Medido em 22/09: dos 34 pagamentos prospectivos em AGUARDANDO_ACORDO, 0/34 batiam por
-- pagamentos.matricula = alunos.matricula (sao identificadores diferentes -- pagamentos.matricula E o
-- registration do Prime). Mas 34/34 sao identificaveis pelo caminho ja comprovado noutra frente:
--   pagamentos.matricula -> prime_contratos.registration -> cpf -> alunos.cpf
--
-- NAO TOCA public.pagamento_conciliar_um NEM public.conciliacao_reprocessar -- preservados exatamente como
-- estao, por pedido explicito. So enriquece identificacao (cpf/aluno_id), nunca decide acordo/baixa. A
-- funcao oficial de conciliacao continua sendo a UNICA a decidir e escrever estado financeiro.
--
-- Onde entra no fluxo: no gatilho de INSERT (_pagamento_conciliar), ANTES de chamar
-- pagamento_conciliar_um -- cobre todo pagamento novo, sem duplicar logica, sem criar job novo. A
-- excecao operacional (tela "Pagamentos sem aluno" / RPC pagamentos_sem_aluno + pagamentos_trava) ja
-- existe e ja mostra "aluno identificado -- acordo nao encontrado" quando aluno_id esta preenchido; esta
-- migration so garante que aluno_id/cpf cheguem preenchidos para os casos que a fonte oficial resolve.
begin;

create or replace function public.pagamentos_resolver_identificacao(p_pagamento_id uuid)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_matricula text; v_aluno_id uuid; v_cpf text; v_cpf_achado text; v_aluno_achado uuid;
begin
  select matricula, aluno_id, cpf into v_matricula, v_aluno_id, v_cpf from public.pagamentos where id = p_pagamento_id;
  if not found or v_aluno_id is not null or coalesce(v_matricula, '') = '' then
    return jsonb_build_object('ok', true, 'alterou', false);
  end if;

  select cpf into v_cpf_achado from public.prime_contratos
   where registration = v_matricula order by valid_from desc limit 1;
  if v_cpf_achado is null then
    return jsonb_build_object('ok', true, 'alterou', false, 'motivo', 'SEM_REGISTRATION_NO_PRIME_CONTRATOS');
  end if;

  select id into v_aluno_achado from public.alunos
   where lpad(regexp_replace(coalesce(cpf, ''), '\D', '', 'g'), 11, '0')
       = lpad(regexp_replace(v_cpf_achado, '\D', '', 'g'), 11, '0')
   limit 1;

  update public.pagamentos
     set cpf = coalesce(cpf, v_cpf_achado), aluno_id = coalesce(aluno_id, v_aluno_achado)
   where id = p_pagamento_id and aluno_id is null;

  return jsonb_build_object('ok', true, 'alterou', true, 'cpf', v_cpf_achado, 'aluno_id', v_aluno_achado);
end;
$function$;

revoke all on function public.pagamentos_resolver_identificacao(uuid) from public, anon, authenticated;
grant execute on function public.pagamentos_resolver_identificacao(uuid) to service_role;

-- gatilho oficial: resolve identificacao ANTES da conciliacao, sem alterar pagamento_conciliar_um
create or replace function public._pagamento_conciliar()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
begin
  perform public.pagamentos_resolver_identificacao(new.id);
  perform public.pagamento_conciliar_um(new.id, true);
  return null;
end;
$fn$;

revoke all on function public._pagamento_conciliar() from public, anon, authenticated;

-- BACKFILL SEGURO dos 34 AGUARDANDO_ACORDO atuais -- so identificacao (cpf/aluno_id), nunca baixa/acordo.
do $$
declare v_id uuid;
begin
  for v_id in select id from public.pagamentos where status_conciliacao = 'AGUARDANDO_ACORDO' and aluno_id is null
  loop
    perform public.pagamentos_resolver_identificacao(v_id);
  end loop;
end $$;

commit;
