-- Divida nova devolve o aluno para a fila.
--
-- Amanda, 26/08/2026: "precisa ajustar se entrar novas parcelas".
--
-- O BURACO, medido: 1.160 alunos estao com status de encerrado (QUITADO,
-- BAIXA_REALIZADA, AGUARDANDO_BAIXA, SALDO_ZERO_CONFIRMADO, SEM_SALDO_EM_ABERTO)
-- E TEM parcela de acordo ativo em aberto. Sao R$ 5.381.998,24 de divida viva
-- que ninguem cobra, porque o aluno esta fora de todas as filas. 332 deles nem
-- operador tem.
--
-- COMO ACONTECE. O status do aluno e a fotografia do momento em que ele foi
-- encerrado. Quando divida nova entra depois -- importacao de acordo,
-- renegociacao, parcela nova -- o acordo e criado, mas nada volta o status
-- atras. O aluno segue marcado como quitado para sempre.
--
-- O caso que revelou: Anna Laura Vilela Grings. Quitada em 17/07; em 20/07 a
-- remessa criou um acordo de R$ 19.030,47 em 4x, todas as parcelas em aberto
-- ate hoje -- e ela invisivel, sem operador, com status BAIXA_REALIZADA de
-- julho. O maior caso da lista chega a R$ 107.227,16.
--
-- A REGRA, simetrica a que subiu hoje de manha:
--
--     saldo zerou          -> sai da fila   (ja existia desde hoje)
--     voltou a ter saldo   -> VOLTA para a fila   (esta migration)
--
-- O status volta para ACORDO_FECHADO, que e o que o sistema ja usa para quem
-- tem acordo ativo -- nao e status novo, e e acionavel.
--
-- NAO apaga historico, nao mexe em dinheiro, nao atribui operador: so devolve
-- para a fila quem voltou a dever. Quem distribui continua sendo o nivelamento.
--
-- CUSTO: a primeira linha do gatilho e uma checagem de status por indice. Na
-- esmagadora maioria das parcelas criadas (aluno que nunca foi encerrado) ele
-- para ali.

create or replace function public._reabrir_aluno_com_divida_nova()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_aluno  uuid;
  v_status text;
begin
  begin
    -- Só interessa parcela que representa dívida viva.
    if upper(coalesce(new.status,'')) not in ('A_VENCER','VENCIDA') then
      return null;
    end if;

    select a.aluno_id into v_aluno
      from public.acordos a
     where a.id = new.acordo_id and a.status = 'ATIVO';

    if v_aluno is null then
      return null;
    end if;

    select upper(coalesce(status_atual,'')) into v_status
      from public.alunos where id = v_aluno;

    -- Só mexe em quem está marcado como encerrado. Aluno normal não é tocado.
    if not (v_status like 'QUIT%'
            or v_status in ('BAIXA_REALIZADA','AGUARDANDO_BAIXA',
                            'SALDO_ZERO_CONFIRMADO','SEM_SALDO_EM_ABERTO')) then
      return null;
    end if;

    update public.alunos
       set status_atual       = 'ACORDO_FECHADO',
           status_jornada     = 'ACORDO_FECHADO',
           status_acionamento = 'ACORDO_FECHADO'
     where id = v_aluno;

    insert into public.aluno_movimentacoes
      (aluno_id, tipo, descricao, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
    values (v_aluno::text, 'REABERTURA_DIVIDA_NOVA',
      'Aluno estava como ' || v_status || ' e voltou a ter parcela de acordo em aberto. '
      || 'Devolvido para a fila automaticamente -- sem isso a divida ficaria invisivel.',
      'ACORDO_FECHADO', 'SISTEMA', 'sistema_reabertura', now());

  exception when others then
    -- Nunca derrubar a criacao da parcela por causa disto.
    return null;
  end;
  return null;
end;
$function$;

drop trigger if exists trg_reabrir_aluno_divida_nova_ins on public.parcelas;
create trigger trg_reabrir_aluno_divida_nova_ins
  after insert on public.parcelas
  for each row
  execute function public._reabrir_aluno_com_divida_nova();

drop trigger if exists trg_reabrir_aluno_divida_nova_upd on public.parcelas;
create trigger trg_reabrir_aluno_divida_nova_upd
  after update of status on public.parcelas
  for each row
  when (upper(coalesce(new.status,'')) in ('A_VENCER','VENCIDA')
        and upper(coalesce(old.status,'')) is distinct from upper(coalesce(new.status,'')))
  execute function public._reabrir_aluno_com_divida_nova();

comment on function public._reabrir_aluno_com_divida_nova() is
  'Devolve o aluno para a fila quando entra parcela de acordo ativo em aberto e ele estava marcado como encerrado. Simetrico a _fechar_confirmacao_ao_zerar_saldo: saldo zerou sai, voltou a ter saldo volta. Nao apaga historico, nao mexe em dinheiro e nao atribui operador.';
