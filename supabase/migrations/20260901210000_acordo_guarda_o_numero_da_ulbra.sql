-- Amanda, 01/09: "lembra que falamos de subir os nossos numeros" --
-- "esses deveriam estar na base".
--
-- O `numero_acordo` do CRM e uma sequencia nossa (292, 2667...), sem relacao com
-- o numero do acordo na Ulbra. O pagamento chega com o numero da ULBRA dentro do
-- documento -- "50" + acordo(5) + parcela(4) -- e nao havia campo ligando um ao
-- outro. A baixa entao tentava achar a parcela por aluno + numero da parcela.
--
-- POR QUE ISSO QUEBRA. Nathan Gomides Brandao: o acordo 292 do CRM e o 50620 da
-- Ulbra, e a parcela #1 carrega o boleto ...0010 -- e a parcela 10 da origem. O
-- Relatorio de Titulos em Aberto so traz o que ainda esta aberto, entao a
-- importacao pegou as parcelas 10, 11 e 12 e renumerou como 1, 2 e 3.
--
-- E o pior caso: Josele dos Santos Rosa, com dois acordos. Casar por posicao
-- lancou o pagamento do acordo 60811 na parcela do 48948, e a parcela de 01/08
-- ficou aberta. Dezoito parcelas ficaram com boleto de outro acordo e foram
-- corrigidas em 01/09 (backup em _backup_boleto_cruzado_20260901).
--
-- O numero ja estava na base, escondido nos titulos do acordo:
-- substr(documento,4,5). Medido: 2.313 de 2.314 acordos com titulo tem um numero
-- unico. A partir daqui ele fica em campo proprio.

alter table public.acordos add column if not exists numero_ulbra text;

create index if not exists ix_acordos_numero_ulbra
  on public.acordos (numero_ulbra) where numero_ulbra is not null;

with n as (
  select t.acordo_id, min(substr(t.documento,4,5)) numero
    from public.acordos_titulos t
   where coalesce(t.tipo_boleto,'')='Acordo' and t.acordo_id is not null
     and t.documento ~ '^\d{12}$'
   group by t.acordo_id
  having count(distinct substr(t.documento,4,5)) = 1
)
update public.acordos a
   set numero_ulbra = n.numero, atualizado_em = now()
  from n where a.id = n.acordo_id and a.numero_ulbra is null;

with f as (
  select fa.acordo_id, min(substr(fa.acordo_base,4,5)) numero
    from public.fila_acordos_confirmar fa
   where fa.acordo_id is not null and fa.acordo_base ~ '^\d{10}$'
   group by fa.acordo_id
  having count(distinct substr(fa.acordo_base,4,5)) = 1
)
update public.acordos a
   set numero_ulbra = f.numero, atualizado_em = now()
  from f where a.id = f.acordo_id and a.numero_ulbra is null;
