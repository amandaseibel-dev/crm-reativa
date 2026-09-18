-- FECHAMENTO DAS EXCECOES HUMANAS -- 18/09/2026 -- OPERACAO 7 -- pagamento 72283
-- Autorizado pela Amanda em 18/09/2026. Duas fichas "Diego Cerezer Flores" com
-- o mesmo CPF; a 1e1b3c9f nao tem mensalidade, caso, atendimento nem financeiro.
-- Mescla pela funcao oficial mesclar_aluno_duplicado, preservando a 27e39174
-- (mensalidades e caso). A duplicada fica marcada CADASTRO_DUPLICADO, nao apagada.
do $op$
declare
  c_manter constant uuid := '27e39174-d618-44bc-bb94-395ebac070d6';
  c_remover constant uuid := '1e1b3c9f-c3f3-4181-b08c-e2205f56086f';
  r record; v_proibidas text := '';
begin
  if (select count(*) from public.alunos a1 join public.alunos a2 on a2.id = c_remover
       where a1.id = c_manter
         and lpad(regexp_replace(coalesce(a1.cpf,''),'\D','','g'),11,'0') = lpad(regexp_replace(coalesce(a2.cpf,''),'\D','','g'),11,'0')
         and regexp_replace(coalesce(a1.cpf,''),'\D','','g') <> ''
         and a1.nome = a2.nome) <> 1 then
    raise exception 'OP7_ABORTADA: as fichas nao tem mais o mesmo CPF e nome';
  end if;
  if coalesce((select status_jornada from public.alunos where id = c_remover),'') = 'CADASTRO_DUPLICADO' then
    raise exception 'OP7_ABORTADA: a ficha ja foi mesclada';
  end if;
  if not exists (select 1 from public.acordos_titulos where aluno_id = c_manter)
     or not exists (select 1 from public.casos where aluno_id = c_manter) then
    raise exception 'OP7_ABORTADA: a ficha principal perdeu mensalidades ou caso';
  end if;
  -- a duplicada nao pode ter nada financeiro, caso nem atendimento
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  for r in select * from public.mesclar_aluno_duplicado(c_manter, c_remover, true, 'fecha_72283_20260918') loop
    if r.tabela in ('acordos_titulos','acordos','parcelas','pagamentos','baixas_pagamento','solicitacoes_confirmacao_pagamento',
                    'casos','aluno_movimentacoes','historico_atendimentos','operador_atendimentos','acordo_titulo_vinculo',
                    'carteira_operador','links_pagamento','fila_pagamento_sem_vinculo') then
      v_proibidas := v_proibidas || r.tabela || ':' || r.linhas || ' ';
    end if;
  end loop;
  if v_proibidas <> '' then raise exception 'OP7_ABORTADA: a ficha duplicada tem registros proprios: %', v_proibidas; end if;

  insert into public._backup_fecha_pagamentos_20260918 (op, tabela, registro_id, antes)
  select 'op7_72283', 'alunos', a.id, to_jsonb(a) from public.alunos a where a.id in (c_manter, c_remover);

  perform * from public.mesclar_aluno_duplicado(c_manter, c_remover, false, 'fecha_72283_20260918');
  perform set_config('request.jwt.claims', '', true);

  if coalesce((select status_jornada from public.alunos where id = c_remover),'') <> 'CADASTRO_DUPLICADO' then
    raise exception 'OP7_ABORTADA: a mesclagem nao marcou a duplicada';
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('fechamento_pagamentos_20260918', 'CADASTRO_DUPLICADO_MESCLADO', 'alunos', c_remover,
          jsonb_build_object('op', 7, 'pagamento', '72283', 'manter', c_manter, 'remover', c_remover,
                             'funcao', 'mesclar_aluno_duplicado', 'autorizado_por', 'amanda.seibel@aelbra.com.br'));
end
$op$;
