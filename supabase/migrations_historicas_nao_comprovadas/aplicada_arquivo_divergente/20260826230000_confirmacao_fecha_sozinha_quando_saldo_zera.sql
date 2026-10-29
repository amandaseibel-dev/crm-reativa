-- A confirmação fecha sozinha quando o aluno não deve mais nada.
--
-- Amanda, 26/08/2026: "se só eu a fernanda e amanda que baixamos, o que ocorre,
-- se algo for lançado foi validado pelo prime, e não pode gerar retrabalho" e
-- "faça com que eu não tenha retrabalho".
--
-- O RETRABALHO, medido: dos 1.726 alunos parados na fila de confirmação, 84 já
-- têm baixa registrada por elas três, e 33 desses já estão com saldo ZERO. A
-- pessoa com autoridade para decidir já decidiu, o dinheiro já entrou, o aluno
-- não deve nada -- e o sistema continua pedindo um segundo clique que não
-- acrescenta informação nenhuma.
--
-- A REGRA. Baixar já é a validação. Quando uma parcela ou mensalidade é quitada
-- e isso zera o saldo do aluno, as confirmações dele em aberto fecham sozinhas.
--
-- O LIMITE, e é o ponto todo: isto NÃO quita ninguém, não apaga dívida e não
-- toca em dinheiro. Só para de segurar na fila quem já não deve nada. A baixa
-- prova que AQUELE PAGAMENTO foi resolvido, não que o aluno está quite -- quem
-- decide isso é a conta do saldo chegando a zero.
--
-- (O caso que ensinou a diferença: aluno com pagamento de R$ 855,01 e dívida de
-- R$ 2.842,04. Encadear "pagou logo quitou" apagaria R$ 1.987 de dívida real.)
--
-- SEGURANÇA: o gatilho nunca pode derrubar uma baixa -- tudo roda dentro de um
-- bloco que engole qualquer erro. E antes de calcular o saldo (caro), confere
-- por índice se o aluno TEM confirmação em aberto; na maioria das baixas ele
-- para na primeira linha.
--
-- A versão final desta função está na migration seguinte
-- (20260826240000), que exige também "zero sem asterisco".

create or replace function public._fechar_confirmacao_ao_zerar_saldo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_aluno uuid;
  v_total numeric;
begin
  begin
    if tg_table_name = 'parcelas' then
      select a.aluno_id into v_aluno from public.acordos a where a.id = new.acordo_id;
    else
      v_aluno := new.aluno_id;
    end if;
    if v_aluno is null then return null; end if;

    if not exists (
      select 1 from public.solicitacoes_confirmacao_pagamento s
      where s.aluno_id = v_aluno::text and s.status = 'AGUARDANDO_CONFIRMACAO'
    ) then
      return null;
    end if;

    v_total := (public.aluno_saldo_pendente_detalhe(v_aluno) ->> 'total')::numeric;
    if coalesce(v_total, 1) > 0.005 then return null; end if;

    update public.solicitacoes_confirmacao_pagamento s
       set status = 'PAGAMENTO_CONFIRMADO',
           observacao_adm = coalesce(nullif(btrim(s.observacao_adm), ''),
                                     'Fechada automaticamente: o aluno ficou sem saldo em aberto.'),
           confirmado_em = coalesce(s.confirmado_em, now()),
           atualizado_em = now()
     where s.aluno_id = v_aluno::text and s.status = 'AGUARDANDO_CONFIRMACAO';
  exception when others then
    return null;
  end;
  return null;
end;
$function$;

drop trigger if exists trg_fechar_confirmacao_parcela on public.parcelas;
create trigger trg_fechar_confirmacao_parcela
  after update of status on public.parcelas
  for each row
  when (upper(coalesce(new.status,'')) = 'PAGO' and upper(coalesce(old.status,'')) <> 'PAGO')
  execute function public._fechar_confirmacao_ao_zerar_saldo();

drop trigger if exists trg_fechar_confirmacao_titulo on public.acordos_titulos;
create trigger trg_fechar_confirmacao_titulo
  after update on public.acordos_titulos
  for each row
  when (
    (upper(coalesce(new.situacao,'')) in ('PAGO','QUITADO') and upper(coalesce(old.situacao,'')) not in ('PAGO','QUITADO'))
    or (lower(coalesce(new.status,'')) in ('quitada','quitado','paga','pago') and lower(coalesce(old.status,'')) not in ('quitada','quitado','paga','pago'))
  )
  execute function public._fechar_confirmacao_ao_zerar_saldo();
