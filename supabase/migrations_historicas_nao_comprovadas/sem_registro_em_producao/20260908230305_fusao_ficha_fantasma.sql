-- REPARO DE DADOS, aplicado em producao em 08/09/2026. Versionado depois --
-- ver o PR "versionar migrations aplicadas" para o porque do atraso.
--
-- Fichas fantasma: mesmo CPF, sem curso, sem caso, sem acordo, criadas por
-- importacao sem chave segura. Elas nao estavam vazias -- seguravam 14
-- pagamentos (R$ 23.609,95) e 3 acordos QUITADOS (R$ 7.992,20) que pertenciam
-- a ficha real do aluno. Enquanto isso, a ficha real seguia cobrando.
--
-- Premissa: UM CPF POR ALUNO. Ver docs/PADRAO_CADASTRO.md.
--
-- Verificado: o saldo dos 5 alunos ficou IDENTICO antes e depois (os acordos
-- estavam quitados, zero parcelas em aberto) e a divida total seguiu em
-- R$ 42.499.141,80. Nao move dinheiro: devolve historico ao dono.
--
-- Idempotente: o UPDATE exige que o registro ainda esteja na ficha fantasma.
create table if not exists public._backup_fusao_ficha_fantasma_20260908 as
with pares as (
  select regexp_replace(al.cpf,'\D','','g') as cpf,
         (array_agg(al.id) filter (where al.curso is null))[1]     as fantasma,
         (array_agg(al.id) filter (where al.curso is not null))[1] as ficha_real
  from alunos al
  where regexp_replace(coalesce(al.cpf,''),'\D','','g')
        in ('00123570220','01922672050','02740813007','03320011057','81859040225')
  group by 1
)
select 'pagamento' as tipo, p.id as registro_id, p.aluno_id as de_aluno,
       pr.ficha_real as para_aluno, pr.cpf, p.valor_pago as valor,
       coalesce(p.titulo_numero,'-') as referencia, now() as copiado_em
  from pagamentos p join pares pr on pr.fantasma = p.aluno_id
union all
select 'acordo', a.id, a.aluno_id, pr.ficha_real, pr.cpf, a.valor_total,
       coalesce(a.numero_acordo::text,'-'), now()
  from acordos a join pares pr on pr.fantasma = a.aluno_id;

alter table public._backup_fusao_ficha_fantasma_20260908 enable row level security;
alter table public._backup_fusao_ficha_fantasma_20260908 force row level security;

update public.pagamentos p
   set aluno_id = b.para_aluno
  from public._backup_fusao_ficha_fantasma_20260908 b
 where b.tipo = 'pagamento' and b.registro_id = p.id and p.aluno_id = b.de_aluno;

update public.acordos a
   set aluno_id = b.para_aluno, atualizado_em = now()
  from public._backup_fusao_ficha_fantasma_20260908 b
 where b.tipo = 'acordo' and b.registro_id = a.id and a.aluno_id = b.de_aluno;
