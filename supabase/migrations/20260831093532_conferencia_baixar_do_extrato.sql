-- BAIXA DIRETO DO EXTRATO -- o caminho que faltava.
--
-- Amanda: "mas os pagamentos nem sempre vem do comprovante de baixa, entrou no
-- extrato precisa baixar". E, sobre as acoes: "tem alunos que estarao quitados,
-- outros com acordo, e rejeitar que ja esta baixado -- tem que ter essas tres
-- opcoes".
--
-- O BURACO. `baixas_pagamento` so ganhava linha por `enviar_comprovante_para_baixa`
-- -- o fluxo do link, que exige comprovante. E `quitar_e_encerrar_caso` apenas
-- ATUALIZA linhas que ja existem:
--     update public.baixas_pagamento set status_baixa='REALIZADA' ... where aluno_id = ...
-- Sem linha, nada era registrado. Como o pagamento do extrato nunca criava linha,
-- o dinheiro do Santander entrava e NUNCA aparecia no relatorio de baixa. E a
-- explicacao do numero que nao fechava: R$ 11,7 mi entraram e o relatorio tem
-- R$ 3,0 mi -- ele so via o caminho do comprovante.
--
-- A evidencia aqui e o proprio extrato (premissa 16), entao nao se exige
-- comprovante.
--
-- O QUE ELA NAO FAZ, de proposito: nao mexe no status do aluno. Quem decide
-- quitacao e `confirmar_baixa_caso`, que so quita com saldo ZERADO -- assim quem
-- tem acordo em aberto continua na cobranca (premissa 3). O legado
-- `concluir_baixa_pagamento` forcava BAIXA_REALIZADA sem olhar saldo, e e dai que
-- vinha "Pago" com divida em aberto.
--
-- AS TRES ACOES DA TELA, com esta funcao no lugar:
--   Baixar      -> registra a baixa; se o saldo zerar quita, senao segue cobrando
--   Quitar      -> quitar_e_encerrar_caso, encerra o caso
--   Ja baixado  -> so decisao, com motivo; nao mexe em dinheiro
--
-- NAO DUPLICA: mesma aluno + valor + data ja REALIZADA devolve a existente.
--
-- ARMADILHA DE VALOR: a base usa 'REALIZADA' e 'DEVOLVIDA'.
-- `concluir_baixa_pagamento` grava 'BAIXA_REALIZADA', que nao existe em nenhuma
-- das 1.683 linhas -- se voltar a ser usada, suas baixas somem de qualquer filtro
-- por 'REALIZADA'. Nenhuma das duas e chamada pelo front hoje.

create or replace function public.conferencia_baixar_do_extrato(
  p_aluno_id uuid, p_valor numeric, p_data date, p_observacao text default null
)
returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_nome text; v_cpf text; v_id uuid; v_ja uuid;
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
  if v_ja is not null then
    return jsonb_build_object('ok', true, 'ja_existia', true, 'baixa_id', v_ja);
  end if;

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

  return jsonb_build_object('ok', true, 'ja_existia', false, 'baixa_id', v_id);
end;
$$;

revoke all on function public.conferencia_baixar_do_extrato(uuid, numeric, date, text) from public, anon;
grant execute on function public.conferencia_baixar_do_extrato(uuid, numeric, date, text) to authenticated, service_role;
