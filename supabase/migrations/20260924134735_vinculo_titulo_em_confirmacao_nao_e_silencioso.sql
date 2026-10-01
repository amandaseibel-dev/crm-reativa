-- Vincular mensalidade presa em confirmacao falha ALTO, nao em silencio.
--
-- O QUE ACONTECIA. Tentar vincular a um acordo uma mensalidade que esta
-- EM_CONFIRMACAO devolvia `ok: true` -- e nao vinculava. O caminho:
--
--   1. `vincular_titulos_acordo` aprova a mensalidade na elegibilidade: o
--      status `em_confirmacao` nao esta na lista de bloqueio, `acordo_id` e
--      nulo e o valor e maior que zero;
--   2. o UPDATE em `acordos_titulos` e revertido pelo gatilho
--      `trg_titulo_em_confirmacao_protegido` (BEFORE UPDATE), que reescreve
--      situacao, status, aluno_id e acordo_id de volta e so registra a recusa
--      em `auditoria` -- sem erro, sem aviso;
--   3. a linha em `acordo_titulo_vinculo` E criada, porque o gatilho protege
--      `acordos_titulos`, nao a tabela de vinculo;
--   4. a prova final da funcao conta exatamente essa linha ("toda mensalidade
--      pedida sai com um vinculo ativo") e passa;
--   5. a funcao responde `ok: true, vinculados: N`, e a tela avisa sucesso.
--
-- Sobra um estado pela metade: vinculo ATIVO apontando para o acordo e
-- mensalidade ainda presa em confirmacao, com `acordo_id` nulo. A composicao
-- do acordo passa a mentir, e nao ha erro em lugar nenhum para investigar.
--
-- POR QUE UM GATILHO NO VINCULO, E NAO UM IF NA FUNCAO. O estado pela metade
-- nasce da linha de vinculo, entao e nela que a recusa tem de morar: qualquer
-- caminho que insira vinculo -- a funcao oficial, uma correcao manual, uma
-- rotina futura -- passa a esbarrar aqui. Barrar so dentro de
-- `vincular_titulos_acordo` deixaria a porta aberta para os outros.
--
-- A CONFERENCIA PRIME CONTINUA PASSANDO. Ela e quem tem autoridade para mexer
-- em titulo EM_CONFIRMACAO e liga `conferencia_prime.decisao = 'on'` na
-- propria transacao antes de chamar `vincular_titulos_acordo` -- a mesma
-- chave que o gatilho de protecao ja usa. Este gatilho respeita a mesma porta.
--
-- ORDEM CERTA PARA QUEM OPERA: solte o titulo da confirmacao
-- (`prime_conferencia_rejeitar` / `_lote`, que devolve a mensalidade para
-- ABERTO) e vincule depois. A partir daqui, fazer na ordem errada da erro
-- na cara, dizendo o que fazer.

create or replace function public._vinculo_titulo_em_confirmacao_bloqueia()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_sit text;
  v_doc text;
begin
  -- Porta da Conferencia Prime: so ela decide sobre titulo em confirmacao.
  if coalesce(current_setting('conferencia_prime.decisao', true), '') = 'on' then
    return new;
  end if;

  select upper(coalesce(t.situacao, '')), t.documento
    into v_sit, v_doc
    from public.acordos_titulos t
   where t.id = new.titulo_id;

  if v_sit = 'EM_CONFIRMACAO' then
    raise exception
      'TITULO_EM_CONFIRMACAO: a mensalidade % esta presa na Conferencia Prime e nao pode ser vinculada assim -- solte-a da confirmacao primeiro (ela volta para ABERTO) e vincule depois. Sem isto o vinculo nasce pela metade: a linha e criada e a mensalidade continua em confirmacao.',
      coalesce(v_doc, new.titulo_id::text)
      using errcode = 'P0001';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_vinculo_titulo_em_confirmacao_bloqueia on public.acordo_titulo_vinculo;
create trigger trg_vinculo_titulo_em_confirmacao_bloqueia
  before insert on public.acordo_titulo_vinculo
  for each row execute function public._vinculo_titulo_em_confirmacao_bloqueia();

comment on function public._vinculo_titulo_em_confirmacao_bloqueia() is
  'Recusa, com erro explicito, criar vinculo para mensalidade EM_CONFIRMACAO fora da Conferencia Prime. Antes o vinculo nascia pela metade e a funcao respondia ok.';
