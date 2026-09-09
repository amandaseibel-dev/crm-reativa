-- REPARO DE DADOS, aplicado em producao em 08/09/2026.
--
-- 18 CPFs tinham divida no portador 195 (ReATIVA Recuperacao) e NENHUMA ficha
-- no CRM. A divida deles estava pendurada na ficha de outra pessoa -- 56
-- titulos, R$ 23.855,74 -- e eles proprios eram invisiveis no sistema.
--
-- POR QUE CRIAR A FICHA ANTES DE SABER O NOME. A Edge Function prime-cadastro
-- busca o cadastro no Prime, mas quem grava e a RPC prime_cadastro_aplicar, que
-- so ATUALIZA aluno existente -- nao cria. E prime_cadastro_pendentes so
-- enfileira CPF que JA tem ficha, entao o mutirao nunca os alcancava.
--
-- A ordem que funciona: cria a ficha com nome PROVISORIO e explicito, roda o
-- prime-cadastro, e ele troca pelo nome de verdade. Feito em 08/09: 18 nomes
-- trocados e 10 telefones colhidos na segunda chamada.
--
-- O nome provisorio e escrito para NAO passar por nome real em tela nenhuma.
-- Curso, campus e matricula vem de prime_contratos -- dado do Prime, nao
-- suposicao. Nenhum CASO e criado: ficha sem nome nao entra em fila.
create table if not exists public._backup_fichas_criadas_20260908 (
  aluno_id uuid, cpf text, criado_em timestamptz default now(), motivo text);

alter table public._backup_fichas_criadas_20260908 enable row level security;
alter table public._backup_fichas_criadas_20260908 force row level security;

with alvo(cpf) as (values
 ('03296188223'),('03699397009'),('03082735088'),('70163718164'),('08381576105'),('04680882026'),
 ('00104203129'),('00191061220'),('85767603049'),('04262746950'),('06693266070'),('04494187070'),
 ('00747227004'),('06586063108'),('02689045109'),('02756440140'),('03700782098'),('08656253107')
), contrato as (
  select regexp_replace(coalesce(pc.cpf,''),'\D','','g') as cpf,
         (array_agg(pc.registration order by pc.valid_from desc nulls last))[1] as matricula,
         (array_agg(pc.curso        order by pc.valid_from desc nulls last))[1] as curso,
         (array_agg(pc.campus       order by pc.valid_from desc nulls last))[1] as campus
    from prime_contratos pc
   where regexp_replace(coalesce(pc.cpf,''),'\D','','g') in (select cpf from alvo)
   group by 1
), novos as (
  insert into public.alunos (nome, cpf, matricula, curso, unidade)
  select 'A IDENTIFICAR (CPF ' || substr(a.cpf,1,3) || '.' || substr(a.cpf,4,3) || '.'
         || substr(a.cpf,7,3) || '-' || substr(a.cpf,10,2) || ')',
         a.cpf, c.matricula, c.curso, c.campus
    from alvo a left join contrato c on c.cpf = a.cpf
   where not exists (select 1 from public.alunos x
                      where regexp_replace(coalesce(x.cpf,''),'\D','','g') = a.cpf)
  returning id, cpf
)
insert into public._backup_fichas_criadas_20260908 (aluno_id, cpf, motivo)
select id, cpf, 'divida no portador 195 sem ficha; nome vem do prime-cadastro' from novos;
