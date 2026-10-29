-- REPARO DE DADOS, aplicado em producao em 08/09/2026.
--
-- Titulos que estavam na ficha de OUTRA PESSOA. Criterio, todo verificavel:
--   1. o CPF do titulo difere do CPF da ficha em que ele esta;
--   2. o PRIME confirma o CPF do titulo pelo numero do boleto;
--   3. ja existe ficha com esse CPF na base;
--   4. o nome do dono e diferente do nome da ficha atual -- isto exclui de
--      proposito os casos "mesma pessoa com dois CPFs", que sao julgamento.
--
-- Sao 5 titulos: 4 PAGOS da Kivia Silva Almeida que sao de Maria Rita Momente
-- Castanheira, e 1 ABERTO de R$ 285,39 da Emilly Camilo Borges que e de
-- Ezequiel da Rosa Tarnoski. Verificado: o saldo da Emilly caiu de R$ 1.043,26
-- para R$ 757,87 e o do Ezequiel subiu de zero para R$ 285,39.
create table if not exists public._backup_titulos_cpf_trocado_20260908 as
select t.id as titulo_id, t.aluno_id as de_aluno, dono.id as para_aluno,
       al.nome as ficha_errada, dono.nome as dono_correto,
       regexp_replace(t.cpf,'\D','','g') as cpf_do_titulo,
       regexp_replace(coalesce(al.cpf,''),'\D','','g') as cpf_da_ficha_errada,
       t.documento, t.situacao,
       coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original, 0) as valor,
       now() as copiado_em
  from acordos_titulos t
  join alunos al on al.id = t.aluno_id
  join lateral (select cpf from prime_titulo_semestre p where p.boleto = t.documento limit 1) ps on true
  join alunos dono on regexp_replace(coalesce(dono.cpf,''),'\D','','g') = regexp_replace(t.cpf,'\D','','g')
 where regexp_replace(t.cpf,'\D','','g') <> regexp_replace(coalesce(al.cpf,''),'\D','','g')
   and regexp_replace(coalesce(ps.cpf,''),'\D','','g') = regexp_replace(t.cpf,'\D','','g')
   and lower(btrim(dono.nome)) <> lower(btrim(al.nome));

alter table public._backup_titulos_cpf_trocado_20260908 enable row level security;
alter table public._backup_titulos_cpf_trocado_20260908 force row level security;

update public.acordos_titulos t
   set aluno_id = b.para_aluno,
       cpf = (select a.cpf from public.alunos a where a.id = b.para_aluno),
       atualizado_em = now()
  from public._backup_titulos_cpf_trocado_20260908 b
 where b.titulo_id = t.id and t.aluno_id = b.de_aluno;
