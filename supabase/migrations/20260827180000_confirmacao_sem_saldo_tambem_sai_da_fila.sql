-- Confirmacao de quem nao deve nada tambem sai da fila.
--
-- Amanda, 27/08/2026: "e possivel verificar fila de confirmacao se ja nao tem
-- casos que estao zerados?".
--
-- Tinha. Quatro, todas nascidas HOJE:
--   Laisa Souza da Rosa, Kleano Goncalves Tavares dos Santos,
--   Roberto Junior Amaral do Nascimento, Mauro da Silva Goncalves
--
-- Todas com origem_divida = 'SEM_SALDO' e o aluno quitado em 26 ou 27/08. Ou
-- seja: o sistema JA SABIA que nao havia divida -- carimbou isso na propria
-- linha -- e mesmo assim colocou o caso na fila para ela conferir.
--
-- POR QUE ESCAPARAM. A trava que tira da fila (_confirmacao_sem_valor_sai_da_
-- fila) so olha o VALOR INFORMADO: se e zero, nao ha o que conferir e ela
-- fecha. Essas quatro tem valor (R$ 689 a R$ 1.955) -- o pagamento existiu.
-- O que nao existe mais e a DIVIDA. Sao coisas diferentes, e so a primeira
-- estava coberta.
--
-- A outra trava (_fechar_confirmacao_ao_zerar_saldo) so dispara quando uma
-- parcela ou titulo MUDA. Aqui nada mudou depois: o aluno ja estava zerado
-- quando a solicitacao nasceu.
--
-- A REGRA DELA, dita em 26/08: "se esta zerado sai" -- "sempre". Entao passa a
-- fechar tambem por SEM_SALDO, como CONCLUIDA_SALDO_ZERO.
--
-- E o gatilho passa a ouvir origem_divida. A tela recarimba a origem dos
-- abertos toda vez que abre (recarimbar_origem_divida_pendentes); com isso, o
-- caso que zerar depois de entrar na fila tambem sai sozinho na proxima visita,
-- sem ninguem precisar varrer nada.
--
-- Nao fecha nada que tenha divida: SEM_SALDO e carimbado por
-- crm_origem_divida_solicitacao, a mesma funcao que classifica as outras.
--
-- As quatro que ja estavam na fila foram fechadas junto, pelo mesmo criterio.

create or replace function public._confirmacao_sem_valor_sai_da_fila()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  begin
    if new.status not in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO') then
      return null;
    end if;

    -- 1) Sem valor informado: nao ha o que conferir.
    if coalesce(new.valor_informado, 0) <= 0.005 then
      update public.solicitacoes_confirmacao_pagamento
         set status = 'ENCERRADO_SEM_VALOR',
             observacao_adm = coalesce(nullif(btrim(observacao_adm),''),
               'Fechada automaticamente: sem valor informado, nao ha o que conferir. O aluno segue na cobranca normalmente.'),
             atualizado_em = now()
       where id = new.id
         and status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO');
      return null;
    end if;

    -- 2) Tem valor, mas o aluno nao deve nada. O pagamento existiu; a divida,
    --    nao existe mais. Conferir o que ja esta zerado e retrabalho puro.
    if upper(coalesce(new.origem_divida,'')) = 'SEM_SALDO' then
      update public.solicitacoes_confirmacao_pagamento
         set status = 'CONCLUIDA_SALDO_ZERO',
             observacao_adm = coalesce(nullif(btrim(observacao_adm),''),
               'Fechada automaticamente: o aluno nao tem saldo em aberto. Nao ha divida para conferir.'),
             confirmado_em = coalesce(confirmado_em, now()),
             atualizado_em = now()
       where id = new.id
         and status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO');
      return null;
    end if;
  exception when others then
    return null;
  end;
  return null;
end;
$function$;

-- Passa a ouvir tambem origem_divida: a tela recarimba os abertos ao abrir,
-- entao quem zerar depois de entrar na fila sai sozinho na proxima visita.
drop trigger if exists trg_confirmacao_sem_valor on public.solicitacoes_confirmacao_pagamento;
create trigger trg_confirmacao_sem_valor
after insert or update of valor_informado, status, origem_divida
on public.solicitacoes_confirmacao_pagamento
for each row execute function public._confirmacao_sem_valor_sai_da_fila();

-- As que ja estavam na fila (4 em 27/08/2026).
update public.solicitacoes_confirmacao_pagamento
   set status = 'CONCLUIDA_SALDO_ZERO',
       observacao_adm = coalesce(nullif(btrim(observacao_adm),''),
         'Fechada automaticamente: o aluno nao tem saldo em aberto. Nao ha divida para conferir.'),
       confirmado_em = coalesce(confirmado_em, now()),
       atualizado_em = now()
 where status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
   and upper(coalesce(origem_divida,'')) = 'SEM_SALDO';
