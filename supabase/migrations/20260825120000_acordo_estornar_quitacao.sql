-- Estornar a QUITAÇÃO INTEIRA de um acordo, numa transação só.
--
-- POR QUE ESTA FUNÇÃO EXISTE
--
-- "Confirmar quitação" baixa todas as parcelas em aberto de um acordo com um
-- clique. O desfazer, até agora, era parcela por parcela na ficha -- errar uma
-- quitação de 12x custava 12 cliques, cada um com seu popup. Pior: se parasse
-- no meio, o acordo ficava num estado misto (parte PAGO, parte A_VENCER).
--
-- E esse estado misto NÃO é hipotético: já aconteceu em produção, pelo caminho
-- oposto (acordo marcado QUITADO com as parcelas ainda A_VENCER, porque o
-- update morreu no meio). Repetir a mesma receita -- N updates sequenciais
-- disparados do navegador, cada um podendo falhar sozinho -- só ampliaria o
-- problema. Por isso o estorno em massa mora AQUI: o corpo de uma função
-- PL/pgSQL é uma transação. Ou tudo volta, ou nada volta.
--
-- PERMISSÃO: espelha a policy `parcelas_update` (amanda.seibel, cobranca04,
-- cobranca07), que é quem de fato consegue mexer em parcela hoje. Deliberado
-- NÃO usar `usuario_e_gestao_financeira()`: ela só reconhece dois e-mails e
-- deixaria a Amanda ADM (cobranca07) de fora sem ninguém perceber -- ela veria
-- o botão na tela e tomaria "permissão negada".
--
-- A baixa NÃO é apagada, é marcada como DEVOLVIDA. `baixas_pagamento` não tem
-- policy de DELETE: um delete falharia em silêncio e deixaria registro
-- fantasma travando a exclusão do acordo depois. Marcar preserva o rastro de
-- quem estornou e quando.
create or replace function public.acordo_estornar_quitacao(
  p_acordo_id uuid,
  p_motivo text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_email     text := lower(trim(coalesce(auth.email(), '')));
  v_acordo    record;
  v_ids       uuid[];
  v_qtd       integer;
  v_valor     numeric;
  v_saldo     numeric;
  v_agora     timestamptz := now();
begin
  if v_email not in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  ) then
    return jsonb_build_object('ok', false, 'erro', 'forbidden');
  end if;

  select id, aluno_id, status into v_acordo
  from public.acordos where id = p_acordo_id;

  if not found then
    return jsonb_build_object('ok', false, 'erro', 'acordo_nao_encontrado');
  end if;

  -- Trava o acordo: dois estornos simultâneos do mesmo acordo não podem
  -- somar em dobro nem se cruzar com uma baixa entrando ao mesmo tempo.
  perform 1 from public.acordos where id = p_acordo_id for update;

  select array_agg(id), count(*), coalesce(sum(valor), 0)
    into v_ids, v_qtd, v_valor
  from public.parcelas
  where acordo_id = p_acordo_id and status = 'PAGO';

  if v_qtd is null or v_qtd = 0 then
    return jsonb_build_object('ok', false, 'erro', 'nada_a_estornar');
  end if;

  update public.baixas_pagamento
     set status_baixa        = 'DEVOLVIDA',
         devolvido_por_email = v_email,
         devolvido_em        = v_agora,
         motivo_devolucao    = coalesce(
           nullif(trim(coalesce(p_motivo, '')), ''),
           'Quitação do acordo estornada na ficha do aluno (correção)'
         )
   where parcela_id = any(v_ids)
     and coalesce(status_baixa, '') <> 'DEVOLVIDA';

  update public.parcelas
     set status               = 'A_VENCER',
         pago_em              = null,
         confirmado_por_email = null,
         atualizado_em        = v_agora
   where id = any(v_ids);

  select coalesce(sum(valor), 0) into v_saldo
  from public.parcelas
  where acordo_id = p_acordo_id and status <> 'PAGO';

  update public.acordos
     set status        = 'ATIVO',
         saldo         = v_saldo,
         atualizado_em = v_agora
   where id = p_acordo_id;

  -- Títulos voltam a contar como dívida viva do acordo.
  update public.acordos_titulos
     set status = 'vinculada', atualizado_em = v_agora
   where id in (
     select titulo_id from public.acordo_titulo_vinculo
     where acordo_id = p_acordo_id and ativo = true
   );

  if v_acordo.aluno_id is not null then
    update public.carteira_operador
       set status = 'ativo', saiu_em = null
     where aluno_id = v_acordo.aluno_id
       and status = 'quitado_saiu';

    -- Só reverte quem ainda está QUITADO por causa desta quitação. Se o aluno
    -- já mudou de status por outro motivo, não mexe.
    update public.alunos
       set status_jornada     = 'EM_ATENDIMENTO',
           status_atual       = 'EM_ATENDIMENTO',
           status_acionamento = 'EM_ATENDIMENTO',
           proxima_acao       = 'CONTATAR'
     where id = v_acordo.aluno_id
       and status_jornada = 'QUITADO';
  end if;

  return jsonb_build_object(
    'ok', true,
    'parcelas', v_qtd,
    'valor', v_valor,
    'saldo_acordo', v_saldo
  );
end;
$$;

revoke all on function public.acordo_estornar_quitacao(uuid, text) from public, anon;
grant execute on function public.acordo_estornar_quitacao(uuid, text) to authenticated;

comment on function public.acordo_estornar_quitacao(uuid, text) is
  'Estorna todas as baixas de um acordo numa transação só (parcelas voltam a A_VENCER, acordo volta a ATIVO, títulos a vinculada, aluno volta pra carteira). Gestão financeira apenas.';
