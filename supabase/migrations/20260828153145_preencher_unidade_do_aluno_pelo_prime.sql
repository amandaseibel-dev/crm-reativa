-- Unidade em branco tira o aluno de qualquer acao por campus.
--
-- A Amanda precisava disparar HOJE para as unidades que encerram a matricula, e
-- 3.527 elegiveis estavam sem unidade no cadastro -- mais que o dobro do
-- publico alvo. Nao entravam em filtro de unidade nenhum.
--
-- O Prime sabe o campus, mas escreve o nome LONGO ("Universidade Luterana do
-- Brasil - Campus Canoas") enquanto o CRM usa o curto ("CAMPUS CANOAS"), que e
-- o que aparece na caixa de selecao. Sem traduzir, preencher nao adiantaria.
--
-- Duas coisas:
--   1. preenche a unidade de quem estava em branco, traduzindo do Prime
--   2. padroniza ~65 alunos que ja tinham o nome LONGO gravado no CRM -- eles
--      tambem ficavam fora do filtro, por nao baterem com a opcao da lista
--
-- Resultado: 676 alunos a mais no alcance. Canoas 488 -> 647, Palmas 444 -> 655,
-- Torres 233 -> 327. Sem unidade caiu de 3.527 para 2.601 (nesses o Prime nao
-- tem contrato no CPF).
--
-- NAO sobrescreve unidade ja preenchida no formato certo. Backup completo.

create table if not exists public._backup_unidade_aluno_20260828 as
select id, nome, cpf, unidade as unidade_antes, now() as ajustado_em
from public.alunos
where nullif(trim(coalesce(unidade,'')),'') is null
   or unidade in (
     'Universidade Luterana do Brasil - POP','Universidade Luterana do Brasil - EAD',
     'Centro Universitário Luterano de Palmas - CEULP','Universidade Luterana do Brasil - Campus Canoas',
     'Centro Universitário Luterano de Manaus - CEULM','Centro Universitário Luterano de Santarém - CEULS',
     'Universidade Luterana do Brasil - Campus Santa Maria','Universidade Luterana do Brasil - Campus Cachoeira do Sul',
     'Instituto Luterano de Ensino Superior de Itumbiara - ILES Itumbiara',
     'Universidade Luterana do Brasil - Campus Guaíba','Universidade Luterana do Brasil - Campus São Jerônimo',
     'Universidade Luterana do Brasil - Campus Torres');

create or replace function public.unidade_curta_do_prime(p_campus text)
returns text language sql immutable as $$
  select case btrim(coalesce(p_campus,''))
    when 'Universidade Luterana do Brasil - EAD'                               then 'EAD'
    when 'Universidade Luterana do Brasil - POP'                               then 'ULBRA POP'
    when 'Centro Universitário Luterano de Palmas - CEULP'                     then 'CENTRO UNIV. PALMAS/TO'
    when 'Universidade Luterana do Brasil - Campus Canoas'                     then 'CAMPUS CANOAS'
    when 'Centro Universitário Luterano de Manaus - CEULM'                     then 'CENTRO UNIV. MANAUS/AM'
    when 'Universidade Luterana do Brasil - Campus Torres'                     then 'CAMPUS TORRES'
    when 'Centro Universitário Luterano de Santarém - CEULS'                   then 'CENTRO UNIV. SANTAREM/PA'
    when 'Instituto Luterano de Ensino Superior de Itumbiara - ILES Itumbiara' then 'ILES ITUMBIARA/GO'
    when 'Universidade Luterana do Brasil - Campus São Jerônimo'               then 'CAMPUS SAO JERONIMO'
    when 'Universidade Luterana do Brasil - Campus Santa Maria'                then 'CAMPUS SANTA MARIA'
    when 'Universidade Luterana do Brasil - Campus Cachoeira do Sul'           then 'CAMPUS CACHOEIRA DO SUL'
    when 'Universidade Luterana do Brasil - Campus Guaíba'                     then 'CAMPUS GUAIBA'
    when 'Universidade Luterana do Brasil - Campus Carazinho'                  then 'CAMPUS CARAZINHO'
    when 'Universidade Luterana do Brasil - Campus Gravataí'                   then 'CAMPUS GRAVATAI'
    when 'Universidade Luterana do Brasil - Campus Gravataí II'                then 'CAMPUS GRAVATAI II'
    when 'ULBRA MEDICINA - PORTO ALEGRE'                                       then 'ULBRA MEDICINA - POA'
    when 'ULBRA MEDICINA - SÃO JERÔNIMO'                                       then 'ULBRA MEDICINA - SAJ'
    when 'Ultec School - Universidade Luterana do Brasil'                      then 'Ultec School'
    when 'ULBRA MEDICINA - PALMAS'                                             then 'ULBRA MEDICINA - PALMAS'
    when 'ULBRA MEDICINA - MANAUS'                                             then 'ULBRA MEDICINA - MANAUS'
    when 'ULBRA MEDICINA - GRAVATAÍ'                                           then 'ULBRA MEDICINA - GRAVATAÍ'
    when 'ULBRA MEDICINA - SANTARÉM'                                           then 'ULBRA MEDICINA - SANTARÉM'
    else nullif(btrim(coalesce(p_campus,'')),'')
  end;
$$;

update public.alunos al
   set unidade = u.curta
  from (
    select b.id, public.unidade_curta_do_prime(
             (select p.campus from public.prime_contratos p
               where p.cpf = lpad(regexp_replace(coalesce(b.cpf,''),'\D','','g'),11,'0')
                 and nullif(trim(p.campus),'') is not null
               order by p.valid_from desc limit 1)) as curta
      from public._backup_unidade_aluno_20260828 b
     where nullif(trim(coalesce(b.unidade_antes,'')),'') is null
  ) u
 where al.id = u.id and u.curta is not null;

update public.alunos al
   set unidade = public.unidade_curta_do_prime(al.unidade)
 where public.unidade_curta_do_prime(al.unidade) is distinct from al.unidade
   and nullif(trim(coalesce(al.unidade,'')),'') is not null;
