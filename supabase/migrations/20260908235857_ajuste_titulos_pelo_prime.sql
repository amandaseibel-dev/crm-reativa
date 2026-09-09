-- REPARO DE DADOS, aplicado em producao em 08/09/2026.
--
-- AJUSTE PELO PRIME. A fonte nomeou os DOIS lados de cada par e decidiu.
--
-- O Prime trocou o nome de 8 fichas do CRM, revelando que elas nao eram de quem
-- o sistema dizia: a ficha tinha copiado o nome de quem teve o titulo grudado
-- nela (dano da fusao por NOME). Com os dois lados nomeados pela fonte:
--   * 15 pares = PESSOAS DIFERENTES -> o titulo volta para o dono;
--   * 3 pares  = MESMA PESSOA com dois CPFs -> nao se move nada; a duplicidade
--     e da ORIGEM (o Prime tem os dois CPFs), nao do CRM.
--
-- Resultado verificado: 35 titulos, 13 fichas de origem, 15 donos. Origem caiu
-- de R$ 61.086,32 para R$ 43.422,20; destino subiu de zero para R$ 17.664,12.
-- Fecha ao centavo. Fichas com mais de um CPF cairam de 22 para 7.
create table if not exists public._backup_ajuste_prime_20260908 as
with nova as (
  select b.aluno_id, regexp_replace(a.cpf,'\D','','g') as cpf, a.nome
    from public._backup_fichas_criadas_20260908 b join alunos a on a.id = b.aluno_id
)
select t.id as titulo_id, t.aluno_id as de_aluno, n.aluno_id as para_aluno,
       al.nome as ficha_errada, n.nome as dono_pelo_prime, n.cpf as cpf_do_titulo,
       regexp_replace(coalesce(al.cpf,''),'\D','','g') as cpf_da_ficha_errada,
       t.documento, t.situacao,
       coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original, 0) as valor,
       now() as copiado_em
  from acordos_titulos t
  join alunos al on al.id = t.aluno_id
  join nova n on n.cpf = regexp_replace(coalesce(t.cpf,''),'\D','','g')
 where regexp_replace(coalesce(t.cpf,''),'\D','','g') <> regexp_replace(coalesce(al.cpf,''),'\D','','g')
   and lower(unaccent(n.nome)) <> lower(unaccent(al.nome));

alter table public._backup_ajuste_prime_20260908 enable row level security;
alter table public._backup_ajuste_prime_20260908 force row level security;

update public.acordos_titulos t
   set aluno_id = b.para_aluno, atualizado_em = now()
  from public._backup_ajuste_prime_20260908 b
 where b.titulo_id = t.id and t.aluno_id = b.de_aluno;
