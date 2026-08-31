-- UMA FILA SO: a Conferencia absorve a confirmacao.
--
-- Amanda: "deixe uma fila so" e, sobre qual e a evidencia, "nao comprovante e
-- sim extrato".
--
-- O PROBLEMA MEDIDO: as 837 confirmacoes abertas estavam TODAS tambem na
-- Conferencia -- sobreposicao de 100% sobre 2.088 pessoas. Baixando pela
-- Conferencia, se o saldo zerava a confirmacao fechava sozinha (ha gatilhos em
-- alunos, casos, parcelas e acordos_titulos). Mas se sobrava saldo -- acordo em
-- aberto, por exemplo -- a confirmacao continuava aberta e o caso reaparecia na
-- outra tela: dois cliques, em telas diferentes, para o mesmo trabalho.
--
-- AGORA a baixa pelo extrato encerra a solicitacao daquele aluno. A evidencia do
-- extrato e melhor que a do comprovante (premissa 16) -- conferido ali, nao ha o
-- que reconferir depois.
--
-- Por isso tambem NAO foi adicionado selo de "comprovante pendente" na linha: a
-- fila e do extrato, e o comprovante deixou de ser o que decide.
--
-- Testado em producao com ROLLBACK: aluno com 1 confirmacao aberta ficou com 0
-- apos a baixa, e a transacao foi revertida.

create or replace function public.conferencia_baixar_do_extrato(
  p_aluno_id uuid, p_valor numeric, p_data date, p_observacao text default null
)
returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_nome text; v_cpf text; v_id uuid; v_ja uuid; v_confs int := 0;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;
  if coalesce(p_valor,0) <= 0 then
    raise exception 'Valor invalido para baixa.';
  end if;

  select nome, cpf into v_nome, v_cpf from public.alunos where id = p_aluno_id;

  select id into v_ja from public.baixas_pagamento
   where aluno_id = p_aluno_id::text and data_pagamento = p_data
     and round(coalesce(valor_pago,0),2) = round(p_valor,2)
     and upper(coalesce(status_baixa,'')) = 'REALIZADA'
   limit 1;

  if v_ja is null then
    insert into public.baixas_pagamento (
      aluno_id, aluno_nome, aluno_cpf, valor_pago, data_pagamento,
      status_baixa, observacao_operador,
      baixado_por_nome, baixado_por_email, baixado_em, recebido_em, atualizado_em
    ) values (
      p_aluno_id::text, v_nome, v_cpf, round(p_valor,2), p_data,
      'REALIZADA',
      coalesce(nullif(btrim(p_observacao),''), 'Baixa pelo extrato do Santander (Conferência de Pagamentos)'),
      v_email, v_email, now(), now(), now()
    ) returning id into v_id;

    insert into public.aluno_movimentacoes
      (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em,
       baixa_pagamento_id, valor_movimentacao)
    values
      (p_aluno_id::text, 'BAIXA_REALIZADA',
       'Baixa registrada a partir do extrato do Santander, na Conferência de Pagamentos.',
       v_email, v_email, now(), v_id, round(p_valor,2));
  end if;

  update public.solicitacoes_confirmacao_pagamento s
     set status = 'PAGAMENTO_CONFIRMADO',
         confirmado_por = v_email,
         confirmado_em = now(),
         atualizado_em = now(),
         observacao_adm = coalesce(s.observacao_adm || ' | ', '')
                          || 'Confirmado pela Conferência de Pagamentos (extrato do Santander).'
   where s.aluno_id = p_aluno_id::text
     and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO');
  get diagnostics v_confs = row_count;

  return jsonb_build_object('ok', true, 'ja_existia', v_ja is not null,
                            'baixa_id', coalesce(v_id, v_ja),
                            'confirmacoes_fechadas', v_confs);
end;
$$;

revoke all on function public.conferencia_baixar_do_extrato(uuid, numeric, date, text) from public, anon;
grant execute on function public.conferencia_baixar_do_extrato(uuid, numeric, date, text) to authenticated, service_role;
