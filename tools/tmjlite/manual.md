# TMJLite — Manual do Usuário

> Versão 0.2 - Capivara · Atualizado em 2026-07-27

---

## Índice

1. [Iniciando o TMJLite](#iniciando-o-tmjlite)
2. [Criando tabelas](#criando-tabelas)
3. [Tipos de dados](#tipos-de-dados)
4. [Chave primária (PK)](#chave-primaria-pk)
5. [Valores padrão](#valores-padrao)
6. [Restrição NOT NULL](#restricao-not-null)
7. [Colunas HASH](#colunas-hash)
8. [Alterando tabelas](#alterando-tabelas)
9. [Removendo tabelas (DROP TABLE)](#removendo-tabelas-drop-table)
10. [Inserindo dados](#inserindo-dados)
11. [Consultando dados](#consultando-dados)
12. [Filtrando com WHERE](#filtrando-com-where)
13. [Ordenando com ORDER BY](#ordenando-com-order-by)
14. [Limitando resultados](#limitando-resultados)
15. [Atualizando dados](#atualizando-dados)
16. [Excluindo dados](#excluindo-dados)
17. [Truncando tabelas (TRUNCATE)](#truncando-tabelas-truncate)
18. [JOINs](#joins)
19. [Apelidos de tabela](#apelidos-de-tabela)
20. [Nomes qualificados de colunas](#nomes-qualificados-de-colunas)
21. [Agregações e GROUP BY](#agregacoes-e-group-by)
22. [Subconsultas](#subconsultas)
23. [Funções de janela](#funcoes-de-janela)
24. [Índices](#indices)
25. [EXPLAIN](#explain)
26. [Transações](#transacoes)
27. [Log de antemão (WAL)](#log-de-antemao-wal)
28. [Trabalhando com arquivos de banco de dados](#trabalhando-com-arquivos-de-banco-de-dados)
29. [Compatibilidade e migração](#compatibilidade-e-migracao)
30. [Comandos do REPL e linha de comando](#comandos-do-repl-e-linha-de-comando)
31. [Opções avançadas](#opcoes-avancadas)
32. [Desempenho e benchmarks](#desempenho-e-benchmarks)
33. [Comentários](#comentarios)
34. [Mensagens de erro](#mensagens-de-erro)
35. [Exemplos](#exemplos)
36. [Branches de dados (git-native)](#branches-de-dados-git-native)

---

## Iniciando o TMJLite

### Modo em memória

Os dados existem apenas enquanto a sessão estiver aberta:

```bash
tmjlite
```

### Com arquivo de banco de dados

Abre um arquivo existente ou cria um novo. Todas as alterações são salvas automaticamente:

```bash
tmjlite mydb.tmjp
```

Você pode usar qualquer extensão de arquivo (`.tmjp`, `.tmjdb`, etc.). Bancos novos usam o
formato do engine paginado (magic `TMJP`). Arquivos `.tmjdb` mais antigos em formatos legados são
detectados e migrados automaticamente na abertura.

### Prefere interface gráfica?

O **TMJStudio** é a IDE nativa do TMJLite (macOS, Windows e Linux): explorer de tabelas,
editor SQL com ⌘/Ctrl+Enter, criação/edição de tabelas e índices por formulário, mock data
e export CSV/JSON. Também abre e cria bancos **SQLite** (`.db`, `.sqlite`), detecta
alterações feitas por outros processos (ex.: migrations) recarregando automaticamente,
e mantém a lista de bancos recentes na tela inicial. Baixe na landing page.

### O que você verá

```
TMJLite 0.2 - Capivara
In-memory mode. Use .open <path> to work with a file.
Type .help for commands.

tmjlite>
```

Digite instruções SQL terminadas com `;` para executá-las. As instruções podem ocupar várias linhas:

```
tmjlite> CREATE TABLE users (
     ...>     id PK,
     ...>     name STRING(100)
     ...> );
Table 'users' created.
```

---

## Criando tabelas

### Sintaxe

```sql
CREATE TABLE table_name (
    column1 TYPE,
    column2 TYPE NOT NULL,
    column3 TYPE DEFAULT('value'),
    column4 TYPE DEFAULT(TODAY) HASH
);
```

Modificadores (`DEFAULT(...)`, `NOT NULL`, `NULL`, `HASH`) podem aparecer em qualquer ordem após o tipo.

### Regras

- Nomes de tabela diferenciam maiúsculas de minúsculas (`users` e `Users` são tabelas diferentes)
- Nomes de coluna diferenciam maiúsculas de minúsculas
- Um nome de tabela não pode ser reutilizado (retornará um erro)
- É necessária pelo menos uma coluna
- Palavras-chave (SELECT, INSERT, TABLE, INDEX, etc.) não podem ser usadas como nomes de tabela ou coluna
- Apenas uma coluna `PK` é permitida por tabela

### Exemplos

Tabela simples:

```sql
CREATE TABLE users (id PK, name STRING(100));
```

Tabela com todos os tipos e modificadores:

```sql
CREATE TABLE employees (
    id PK,
    name STRING(100) NOT NULL,
    bio TEXT,
    salary FLOAT NOT NULL,
    birth_date DATE,
    hired_at DATETIME DEFAULT(TODAY),
    password STRING(255) NOT NULL HASH,
    active BOOL
);
```

---

## Tipos de dados

### PK

Chave primária. Gera automaticamente um UUID único para cada linha inserida. Não nula, não atribuível manualmente. Cada tabela pode ter no máximo uma coluna PK.

```sql
CREATE TABLE users (id PK, name STRING(100));
INSERT INTO users VALUES ('Thiago');  -- id é gerado automaticamente
```

```
+--------------------------------------+--------+
| id                                   | name   |
+--------------------------------------+--------+
| a1b2c3d4-e5f6-7890-abcd-ef1234567890 | Thiago |
+--------------------------------------+--------+
```

Colunas PK são **omitidas** no INSERT — você fornece valores apenas para as outras colunas.

### INT

Inteiro com sinal de 64 bits. Intervalo: -9.223.372.036.854.775.808 a 9.223.372.036.854.775.807.

```sql
CREATE TABLE scores (player_id INT, points INT);
INSERT INTO scores VALUES (1, 42);
INSERT INTO scores VALUES (2, -10);
```

Aliases: `INTEGER`

### TEXT

String UTF-8 sem limite de tamanho. Delimitada por aspas simples `'...'`. Use `''` para escapar uma aspa dentro da string.

```sql
CREATE TABLE messages (id INT, content TEXT);
INSERT INTO messages VALUES (1, 'Hello World');
INSERT INTO messages VALUES (2, 'It''s a test');
```

Aliases: `VARCHAR`

### STRING / STRING(N)

String UTF-8 com tamanho máximo.

- `STRING` — padrão de 255 caracteres no máximo
- `STRING(N)` — N caracteres no máximo, onde N vai de 0 a 8000

O TMJLite valida o comprimento em cada INSERT. Se o valor exceder o limite, a inserção é rejeitada.

```sql
CREATE TABLE codes (
    short_code STRING(5),
    description STRING
);

INSERT INTO codes VALUES ('ABC', 'Some description');   -- OK
INSERT INTO codes VALUES ('TOOLONG', 'Another one');    -- Error: exceeds STRING(5)
```

### FLOAT

Ponto flutuante de 64 bits (precisão dupla IEEE 754).

```sql
CREATE TABLE measurements (sensor TEXT, value FLOAT);
INSERT INTO measurements VALUES ('temp', 23.5);
INSERT INTO measurements VALUES ('pressure', -1.01325);
```

Aliases: `REAL`, `DOUBLE`

### BOOL

Valor booleano. Aceita `TRUE` ou `FALSE` (sem distinção de maiúsculas/minúsculas).

```sql
CREATE TABLE features (name STRING(50), enabled BOOL);
INSERT INTO features VALUES ('dark_mode', TRUE);
INSERT INTO features VALUES ('beta', FALSE);
```

Aliases: `BOOLEAN`

### DATE

Data no formato `yyyy-MM-dd`. O TMJLite valida o formato em cada INSERT.

```sql
CREATE TABLE events (name STRING(100), event_date DATE);
INSERT INTO events VALUES ('Launch', '2026-06-09');
INSERT INTO events VALUES ('Review', '2026-12-25');
```

Aceita `DEFAULT(TODAY)` — veja [Valores padrão](#valores-padrao).

### DATETIME

Data e hora no formato `yyyy-MM-dd HH:mm:ss:ms` (milissegundos separados por `:`). O TMJLite valida o formato em cada INSERT.

```sql
CREATE TABLE logs (message TEXT, created_at DATETIME);
INSERT INTO logs VALUES ('Server started', '2026-06-09 14:30:45:000');
INSERT INTO logs VALUES ('Request received', '2026-06-09 14:30:45:123');
```

Aceita `DEFAULT(TODAY)` — veja [Valores padrão](#valores-padrao).

### NULL

Por padrão, qualquer coluna aceita `NULL`. Representa a ausência de valor.

```sql
INSERT INTO users VALUES ('Thiago', NULL);
```

Exceções:
- Colunas `PK` são sempre geradas automaticamente e nunca são nulas
- Colunas marcadas com `NOT NULL` rejeitam valores nulos — veja [Restrição NOT NULL](#restricao-not-null)

### Resumo dos tipos

| Tipo         | Armazenamento | Valores de exemplo                | Aliases          |
|--------------|---------------|-----------------------------------|------------------|
| `PK`         | UUID          | *(gerado automaticamente)*        | —                |
| `INT`        | 64 bits       | `42`, `-7`, `0`                   | `INTEGER`        |
| `TEXT`       | UTF-8         | `'hello'`, `'it''s'`              | `VARCHAR`        |
| `STRING`     | UTF-8         | `'hello'` (máx. 255 caracteres)   | —                |
| `STRING(N)`  | UTF-8         | `'hello'` (máx. N caracteres, 0-8000) | —            |
| `FLOAT`      | 64 bits       | `3.14`, `-0.5`, `100.0`           | `REAL`, `DOUBLE` |
| `BOOL`       | 1 bit         | `TRUE`, `FALSE`                   | `BOOLEAN`        |
| `DATE`       | texto         | `'2026-06-09'`                    | —                |
| `DATETIME`   | texto         | `'2026-06-09 14:30:45:123'`       | —                |

---

## Chave primária (PK)

O tipo `PK` cria uma coluna identificadora única gerada automaticamente usando UUID v4.

### Regras

- Apenas **uma** coluna PK por tabela
- O valor é **gerado automaticamente** — você não pode defini-lo manualmente
- Colunas PK **não são nulas** — toda linha sempre tem um UUID
- Colunas PK são **omitidas** em instruções INSERT

### Exemplo

```sql
CREATE TABLE products (id PK, name STRING(100), price FLOAT);

-- INSERT fornece apenas name e price (2 valores, não 3)
INSERT INTO products VALUES ('Keyboard', 249.90);
INSERT INTO products VALUES ('Mouse', 89.90);

SELECT * FROM products;
```

```
+--------------------------------------+----------+-------+
| id                                   | name     | price |
+--------------------------------------+----------+-------+
| f47ac10b-58cc-4372-a567-0e02b2c3d479 | Keyboard | 249.9 |
| 7c9e6679-7425-40de-944b-e07fc1f90ae7 | Mouse    | 89.9  |
+--------------------------------------+----------+-------+
2 row(s)
```

Se você tentar passar um valor para uma coluna PK, receberá um erro porque a contagem de valores não corresponderá:

```
Execution error: expected 2 values (Pk columns are auto-generated), got 3
```

---

## Valores padrão

Define um valor padrão para uma coluna. Quando `NULL` é inserido (ou a coluna é omitida em um INSERT com lista de colunas), o padrão é usado no lugar.

### Sintaxe

```sql
CREATE TABLE table_name (
    city STRING(50) DEFAULT('Curitiba'),
    score INT DEFAULT(0),
    active BOOL DEFAULT(TRUE),
    date_col DATE DEFAULT(TODAY),
    datetime_col DATETIME DEFAULT(TODAY)
);
```

### Padrões suportados

| Padrão                  | Válido em              | Descrição                              |
|-------------------------|------------------------|----------------------------------------|
| `DEFAULT('text')`       | TEXT, STRING(N)        | Literal de string                      |
| `DEFAULT(42)`           | INT                    | Literal inteiro                        |
| `DEFAULT(3.14)`         | FLOAT                  | Literal de ponto flutuante             |
| `DEFAULT(TRUE/FALSE)`   | BOOL                   | Literal booleano                       |
| `DEFAULT(TODAY)`        | DATE, DATETIME         | Data/hora atual no momento da inserção |

### Como funciona

- Se você inserir `NULL` em uma coluna com padrão, o valor padrão é usado
- Se você omitir uma coluna em um INSERT com lista de colunas, o padrão é usado
- Se você inserir um valor explícito, o padrão **não** é aplicado
- O valor padrão deve corresponder ao tipo da coluna (validado na criação da tabela)

### Exemplos

```sql
CREATE TABLE users (
    id PK,
    name STRING(100) NOT NULL,
    city STRING(50) DEFAULT('Curitiba'),
    score INT DEFAULT(0),
    created DATE DEFAULT(TODAY)
);

INSERT INTO users VALUES ('Thiago', NULL, NULL, NULL);
-- city = 'Curitiba', score = 0, created = data de hoje

INSERT INTO users (name) VALUES ('Maria');
-- city = 'Curitiba', score = 0, created = data de hoje

INSERT INTO users VALUES ('Joao', 'SP', 100, '2025-01-01');
-- city = 'SP', score = 100, created = 2025-01-01
```

### DEFAULT(TODAY)

Padrão especial para colunas de data que usa a data/hora atual no momento da inserção:

```sql
CREATE TABLE audit (id PK, action TEXT, ts DATETIME DEFAULT(TODAY));

INSERT INTO audit VALUES ('user_login', NULL);       -- ts = data+hora+ms atuais
```

```
+--------------------------------------+------------+-------------------------+
| id                                   | action     | ts                      |
+--------------------------------------+------------+-------------------------+
| d4e5f6a7-b8c9-0123-d4e5-f6a7b8c90123 | user_login | 2026-06-09 14:30:45:123 |
+--------------------------------------+------------+-------------------------+
```

---

## Restrição NOT NULL

Por padrão, todas as colunas aceitam `NULL`. Use `NOT NULL` para exigir um valor.

### Sintaxe

```sql
CREATE TABLE table_name (
    name STRING(100) NOT NULL,
    age INT NOT NULL,
    bio TEXT                    -- aceita NULL (padrão)
);
```

### Regras

- `NOT NULL` significa que a coluna não pode conter valores NULL
- Colunas PK são implicitamente NOT NULL
- Se uma coluna `NOT NULL` tem `DEFAULT`, inserir NULL aplica o padrão (não gera erro)
- Ao usar INSERT com lista de colunas, omitir uma coluna NOT NULL sem padrão produz um erro
- Você pode marcar explicitamente uma coluna como `NULL` (comportamento padrão)

### Exemplo

```sql
CREATE TABLE users (id PK, name STRING(100) NOT NULL, email STRING(255));

INSERT INTO users VALUES ('Thiago', 'thiago@email.com');  -- OK
INSERT INTO users VALUES (NULL, 'test@email.com');        -- Error: name does not accept NULL
INSERT INTO users VALUES ('Maria', NULL);                 -- OK: email accepts NULL
```

```
Execution error: column 'name' does not accept NULL (NOT NULL)
```

---

## Colunas HASH

O modificador `HASH` faz hash automático dos valores em INSERT e UPDATE usando **Argon2id**
(função de hash de senha). O valor original **nunca é armazenado** — apenas o hash.

> **Mudança incompatível (2026-06):** Valores novos e atualizados são armazenados como strings PHC
> (`$argon2id$v=19$m=19456,t=2,p=1$...`), não como hex SHA-256 de 64 caracteres. Linhas escritas
> antes dessa mudança mantêm seus valores SHA-256 legados até você `UPDATE` a coluna; ambos os
> formatos podem ser verificados com a API de verificação de hash do engine (`hash_column::verify_hash_value`).

### Sintaxe

```sql
CREATE TABLE table_name (
    column1 STRING(255) HASH,
    column2 TEXT HASH
);
```

### Regras

- `HASH` é válido apenas em colunas `STRING`, `STRING(N)` e `TEXT`
- Cada coluna HASH recebe seu próprio salt aleatório único, gerado quando a tabela é criada
- Valores são hasheados em INSERT e UPDATE — armazenados como string PHC Argon2id (`$argon2id$...`)
- O hash é **irreversível** — não há como recuperar o valor original
- Valores `NULL` **não são hasheados** — permanecem como NULL
- A validação de comprimento STRING(N) é aplicada ao valor de **entrada** (antes do hash)
- Linhas legadas (hex SHA-256 de 64 caracteres de builds antigos do TMJLite) permanecem legíveis; faça `UPDATE` na coluna para migrar para Argon2id

### Exemplo

```sql
CREATE TABLE users (
    id PK,
    name STRING(100),
    password STRING(255) HASH
);

INSERT INTO users VALUES ('Thiago', '123456');
INSERT INTO users VALUES ('Maria', 'senha_secreta');

SELECT * FROM users;
```

```
+--------------------------------------+--------+------------------------------------------------------------------+
| id                                   | name   | password                                                         |
+--------------------------------------+--------+------------------------------------------------------------------+
| a1b2c3d4-e5f6-7890-abcd-ef1234567890 | Thiago | $argon2id$v=19$m=19456,t=2,p=1$... (truncated)                  |
| b2c3d4e5-f6a7-8901-bcde-f12345678901 | Maria  | $argon2id$v=19$m=19456,t=2,p=1$... (truncated)                  |
+--------------------------------------+--------+------------------------------------------------------------------+
2 row(s)
```

(As strings PHC exatas dependem do salt da coluna; a mesma senha na mesma coluna sempre produz o mesmo hash.)

### Login por SQL

Um literal comparado com uma coluna `HASH` no `WHERE` é hasheado com o salt da
coluna antes da comparação — o mesmo que o `INSERT` faz. Então a verificação
de senha é um `SELECT` comum, sem precisar de API extra:

```sql
SELECT id, name FROM users WHERE name = 'Thiago' AND password = '123456';   -- 1 linha: senha confere
SELECT id, name FROM users WHERE name = 'Thiago' AND password = 'errada';   -- (empty)
UPDATE users SET password = 'nova' WHERE name = 'Thiago' AND password = '123456';  -- troca conferindo a atual
```

Vale para `SELECT`, `UPDATE` e `DELETE`, com ou sem alias de tabela. Um literal
que já é um hash (`$argon2id$…` ou os 64 hex do SHA-256 legado) passa intacto,
então comparar com o valor armazenado também funciona. Cada comparação custa um
Argon2id (~dezenas de ms) — é o preço certo para login, não para varreduras.

### Segurança

- Algoritmo: **Argon2id** com parâmetros fixos do engine — memória 19 MiB (`m=19456`), custo de tempo 2, paralelismo 1 (codificados no prefixo PHC)
- Cada coluna HASH tem seu **próprio salt único**, então a mesma senha em colunas diferentes produz hashes diferentes
- O salt por coluna é armazenado no arquivo de banco de dados como metadado da coluna (combinado com o salt embutido do Argon2 na string PHC)
- Inserir o mesmo valor duas vezes na mesma coluna produz o **mesmo hash** (determinístico por coluna)
- Linhas SHA-256 legadas (anteriores a 2026-06) ainda são verificáveis; execute `UPDATE ... SET col = '<plaintext>'` para re-hashear com Argon2id

### Exibição do schema

```
tmjlite> .schema users
CREATE TABLE users (
    id PK,
    name STRING(100),
    password STRING(255) HASH
);
```

---

## Alterando tabelas

Modifique a estrutura da tabela após a criação com `ALTER TABLE`.

### ADD COLUMN

Adiciona uma nova coluna. Linhas existentes recebem `NULL` (ou o valor padrão) na nova coluna.

```sql
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD city STRING(50) NOT NULL DEFAULT('Curitiba');  -- a palavra-chave COLUMN é opcional
```

Regras:
- Não é possível adicionar uma coluna `PK`
- Não é possível adicionar coluna `NOT NULL` sem padrão a uma tabela que já possui linhas

### DROP COLUMN

Remove uma coluna e seus dados de todas as linhas.

```sql
ALTER TABLE users DROP COLUMN bio;
ALTER TABLE users DROP bio;  -- a palavra-chave COLUMN é opcional
```

Regras:
- Não é possível remover uma coluna `PK`
- Não é possível remover a última coluna de uma tabela

### MODIFY COLUMN

Altera o tipo, tamanho ou modificadores de uma coluna.

```sql
ALTER TABLE users MODIFY COLUMN name STRING(255);
ALTER TABLE users MODIFY name STRING(100) NOT NULL;  -- a palavra-chave COLUMN é opcional
ALTER TABLE users MODIFY password STRING(255) HASH;  -- adiciona HASH aos dados existentes
```

Regras:
- Não é possível modificar colunas `PK`
- Mudanças de tipo são permitidas entre tamanhos de `STRING` e `TEXT ↔ STRING`
- Alterar para `NOT NULL` falha se os dados existentes contiverem valores NULL
- Reduzir `STRING(N)` falha se os dados existentes excederem o novo tamanho
- Adicionar `HASH` faz hash de todos os valores existentes na coluna
- Remover `HASH` não é permitido (irreversível)

### SET MERGE POLICY

Define como o merge de **sessões shadow** (escrita concorrente multi-processo,
ver `ShadowConnection` nos drivers) resolve conflitos nesta tabela — quando
outro processo alterou a mesma linha desde o snapshot da sessão.

```sql
ALTER TABLE listing SET MERGE POLICY error;        -- conflito aborta o merge inteiro
ALTER TABLE listing SET MERGE POLICY field_merge;  -- combina colunas distintas (3-way)
ALTER TABLE listing SET MERGE POLICY manual;       -- aplica o limpo, quarentena o resto (.tmjc)
ALTER TABLE listing SET MERGE POLICY lww;          -- shadow vence (comportamento padrão)
ALTER TABLE listing SET MERGE POLICY DEFAULT;      -- volta ao default da sessão
```

Regras:
- A política fica gravada no catálogo do arquivo `.tmjp` — vale para qualquer
  processo que fizer merge nesta tabela
- Uma política passada em runtime pelo driver (`set_merge_policy` /
  `SetMergePolicy`) tem precedência sobre a do catálogo
- Não reescreve linhas; dentro de `BEGIN` aplica imediatamente (como
  `CREATE INDEX`) e não é desfeita por `ROLLBACK`

### Exemplos

```sql
-- Adicionar uma coluna
ALTER TABLE products ADD category STRING(50);

-- Tornar uma coluna obrigatória
ALTER TABLE products MODIFY name STRING(200) NOT NULL;

-- Remover uma coluna não utilizada
ALTER TABLE products DROP category;

-- Adicionar hash a uma coluna de senha existente
ALTER TABLE users MODIFY password STRING(255) HASH;
```

---

## Removendo tabelas (DROP TABLE)

Remove a tabela inteira — schema, linhas e índices associados.

### Sintaxe

```sql
DROP TABLE table_name;
```

### Regras

- A tabela deixa de existir no catálogo; consultas posteriores falham com `table not found`
- Índices secundários da tabela são removidos junto
- Diferente de `DELETE` / `TRUNCATE`: a estrutura **não** é preservada
- Pode ser desfeito com `ROLLBACK` se estiver dentro de uma transação

### Exemplos

```sql
DROP TABLE temp_orders;

BEGIN;
DROP TABLE scratch;
ROLLBACK;  -- scratch volta a existir
```

### Saída

```
tmjlite> DROP TABLE temp_orders;
Table 'temp_orders' dropped.
```

---

## Inserindo dados

### INSERT posicional

Forneça todos os valores não-PK na ordem das colunas:

```sql
INSERT INTO table_name VALUES (value1, value2, value3);
```

### INSERT com lista de colunas

Especifique quais colunas preencher. Colunas omitidas recebem o valor padrão (ou NULL):

```sql
INSERT INTO table_name (col1, col3) VALUES (value1, value3);
```

### INSERT em lote

Insira várias linhas em uma única instrução:

```sql
INSERT INTO table_name VALUES (1, 'a'), (2, 'b'), (3, 'c');
INSERT INTO table_name (col1) VALUES ('a'), ('b'), ('c');
```

### Retorno do PK

Ao inserir uma **única linha** em uma tabela com PK, o UUID gerado é exibido:

```
tmjlite> INSERT INTO users VALUES ('Thiago');
Inserted 1 row into 'users'. PK: a1b2c3d4-e5f6-7890-abcd-ef1234567890 (1 total)
```

Inserções em lote exibem apenas a contagem de linhas:

```
tmjlite> INSERT INTO users VALUES ('Maria'), ('Joao');
Inserted 2 row(s) into 'users'. (3 total)
```

### Regras

- O número de valores deve corresponder ao número de colunas **não-PK** (posicional) ou à contagem de colunas especificadas (lista de colunas)
- Colunas PK são geradas automaticamente e devem ser **omitidas** — você não pode defini-las manualmente
- Cada valor deve corresponder ao tipo da coluna (ou ser `NULL`)
- Strings devem estar entre aspas simples: `'assim'`
- Números negativos usam o prefixo `-`: `-42`, `-3.14`
- Valores DATE devem seguir o formato `yyyy-MM-dd`
- Valores DATETIME devem seguir o formato `yyyy-MM-dd HH:mm:ss:ms`
- Valores STRING(N) são validados contra o comprimento máximo
- Colunas NOT NULL rejeitam NULL e não devem ser omitidas sem um padrão
- Colunas HASH têm seus valores hasheados automaticamente antes do armazenamento

### Verificação de tipos

O TMJLite valida tipos na inserção. Tipos incompatíveis produzem um erro:

```
tmjlite> CREATE TABLE t (id INT);
Table 't' created.

tmjlite> INSERT INTO t VALUES ('not a number');
Type error: column 'id' expects INT, got Text("not a number")
```

A única conversão automática é **inteiro → FLOAT**: `INSERT … VALUES (42)` ou
`UPDATE … SET preco = 42` numa coluna `FLOAT` grava `42.0`. O caminho inverso
(`1.5` numa coluna `INT`) continua sendo erro de tipo.

Validação de comprimento para STRING(N):

```
tmjlite> CREATE TABLE t (code STRING(3));
Table 't' created.

tmjlite> INSERT INTO t VALUES ('ABCD');
Type error: column 'code': string length 4 exceeds STRING(3)
```

Validação de formato de data:

```
tmjlite> CREATE TABLE t (d DATE);
Table 't' created.

tmjlite> INSERT INTO t VALUES ('not-a-date');
Type error: column 'd': invalid date 'not-a-date', expected yyyy-MM-dd
```

### Exemplos

```sql
-- Posicional: todos os valores não-PK em ordem
INSERT INTO users VALUES ('Thiago', 'thiago@email.com', '123456');

-- Lista de colunas: apenas colunas especificadas, o restante recebe padrões/NULL
INSERT INTO users (name) VALUES ('Maria');

-- Lote: várias linhas de uma vez
INSERT INTO users (name, email) VALUES ('Joao', 'joao@email.com'), ('Ana', 'ana@email.com');
```

---

## Consultando dados

### Sintaxe

```sql
SELECT columns FROM table [WHERE condition] [ORDER BY col [ASC|DESC], ...] [LIMIT n];
```

### SELECT de todas as colunas

```sql
SELECT * FROM users;
```

```
+--------------------------------------+--------+
| id                                   | name   |
+--------------------------------------+--------+
| a1b2c3d4-e5f6-7890-abcd-ef1234567890 | Thiago |
| b2c3d4e5-f6a7-8901-bcde-f12345678901 | Maria  |
+--------------------------------------+--------+
2 row(s)
```

### SELECT de colunas específicas

```sql
SELECT name FROM users;
```

```
+--------+
| name   |
+--------+
| Thiago |
| Maria  |
+--------+
2 row(s)
```

As colunas são retornadas na ordem que você especificar:

```sql
SELECT name, id FROM users;
```

### Tabela vazia

```
tmjlite> SELECT * FROM users;
(empty)
```

### Tabela ou coluna inexistente

```
tmjlite> SELECT * FROM xyz;
Execution error: table 'xyz' not found

tmjlite> SELECT abc FROM users;
Execution error: column 'abc' not found in table 'users'
```

---

## Filtrando com WHERE

Use `WHERE` para filtrar linhas em instruções SELECT, UPDATE e DELETE.

### Sintaxe

```sql
SELECT columns FROM table WHERE condition;
UPDATE table SET col = val WHERE condition;
DELETE FROM table WHERE condition;
```

### Operadores de comparação

| Operador | Significado           | Exemplo                |
|----------|-----------------------|------------------------|
| `=`      | Igual                 | `age = 30`             |
| `!=`     | Diferente             | `status != 'inactive'` |
| `<>`     | Diferente (alternativo) | `status <> 'inactive'` |
| `<`      | Menor que             | `age < 18`             |
| `>`      | Maior que             | `price > 100.0`        |
| `<=`     | Menor ou igual        | `age <= 25`            |
| `>=`     | Maior ou igual        | `score >= 90`          |

### Comparações entre tipos diferentes

Quando o valor comparado não é do mesmo tipo da coluna, o TMJLite aplica estas regras:

| Coluna vs valor            | Comportamento                                                        |
|----------------------------|----------------------------------------------------------------------|
| `INT` vs literal `FLOAT`   | Comparação **numérica** — `WHERE age = 25.0` casa com `25`           |
| `PK` (UUID) vs string      | Comparação **textual** — `WHERE id = 'f47ac10b-...'` casa a linha    |
| `DATE`/`DATETIME` vs string | Comparação **textual** (o formato ISO ordena corretamente)          |
| Tipos incompatíveis        | **Nunca** são iguais — `WHERE age = 'trinta'` não casa nenhuma linha |

Essas regras valem igualmente para `SELECT`, `UPDATE` e `DELETE`.

> **Correção importante (0.2.3):** em versões ≤ 0.2.2, comparações entre tipos
> diferentes eram tratadas como *iguais* — `UPDATE`/`DELETE` com `WHERE id = '<uuid>'`
> atingia **todas** as linhas da tabela. Se você usa filtro por PK (ou compara INT
> com FLOAT) em UPDATE/DELETE, atualize imediatamente para 0.2.3+.

### Operadores lógicos

Combine condições com `AND`, `OR` e `NOT`. Use parênteses para controlar a precedência.

Precedência dos operadores (da maior para a menor): `NOT` > `AND` > `OR`.

```sql
-- AND: ambas as condições devem ser verdadeiras
SELECT * FROM users WHERE age >= 18 AND active = TRUE;

-- OR: pelo menos uma condição deve ser verdadeira
SELECT * FROM users WHERE city = 'SP' OR city = 'RJ';

-- NOT: nega uma condição
SELECT * FROM users WHERE NOT active = FALSE;

-- Parênteses: sobrescrevem a precedência padrão
SELECT * FROM users WHERE (city = 'SP' OR city = 'RJ') AND active = TRUE;
```

### Verificações de NULL

Use `IS NULL` e `IS NOT NULL` para verificar valores NULL. Operadores de comparação regulares (`=`, `!=`, etc.) retornam false quando qualquer lado é NULL.

```sql
-- Encontrar linhas onde o e-mail está ausente
SELECT * FROM users WHERE email IS NULL;

-- Encontrar linhas onde o e-mail está presente
SELECT * FROM users WHERE email IS NOT NULL;
```

### Exemplos

```sql
-- Filtrar por texto
SELECT * FROM users WHERE name = 'Thiago';

-- Filtrar por intervalo numérico
SELECT * FROM products WHERE price >= 100.0 AND price <= 500.0;

-- Filtrar por booleano
SELECT name FROM users WHERE active = TRUE;

-- Filtrar por data
SELECT * FROM audit WHERE timestamp >= '2026-06-01';

-- Condição complexa
SELECT * FROM users WHERE (age > 25 OR city = 'Curitiba') AND active = TRUE;
```

Filtros de igualdade e intervalo em **colunas indexadas** usam busca no índice / varredura por intervalo
em vez de varrer todas as linhas. Veja [Índices](#indices).

---

## Ordenando com ORDER BY

Use `ORDER BY` para ordenar os resultados da consulta.

### Sintaxe

```sql
SELECT columns FROM table ORDER BY column1 [ASC|DESC], column2 [ASC|DESC];
```

- `ASC` (ascendente) é o padrão se nenhuma direção for especificada
- `DESC` ordena em ordem decrescente
- Várias colunas são suportadas — as linhas são ordenadas pela primeira coluna, depois pela segunda em caso de empate, etc.
- Valores NULL são ordenados primeiro (antes de qualquer valor não NULL)

### Exemplos

```sql
-- Ordenar por nome alfabeticamente (ascendente é o padrão)
SELECT * FROM users ORDER BY name;

-- Ordenar por idade, mais velhos primeiro
SELECT * FROM users ORDER BY age DESC;

-- Ordenar por várias colunas
SELECT * FROM users ORDER BY city ASC, name ASC;

-- Combinar com WHERE
SELECT * FROM users WHERE active = TRUE ORDER BY name;
```

```
tmjlite> SELECT name, age FROM users ORDER BY age DESC;
+--------+-----+
| name   | age |
+--------+-----+
| Joao   | 40  |
| Thiago | 30  |
| Maria  | 25  |
| Ana    | 25  |
+--------+-----+
4 row(s)
```

---

## Limitando resultados

Use `LIMIT` para restringir o número de linhas retornadas.

### Sintaxe

```sql
SELECT columns FROM table LIMIT n;
```

- `n` deve ser um inteiro não negativo
- `LIMIT 0` não retorna linhas
- Se `n` exceder o número total de linhas, todas as linhas são retornadas

### Exemplos

```sql
-- Obter apenas as 5 primeiras linhas
SELECT * FROM users LIMIT 5;

-- Combinar com ORDER BY para obter os top N
SELECT name, score FROM players ORDER BY score DESC LIMIT 3;

-- Combinar WHERE, ORDER BY e LIMIT
SELECT name, age FROM users WHERE active = TRUE ORDER BY age DESC LIMIT 10;
```

Se `ORDER BY` usar uma **coluna indexada** com `ASC` e `LIMIT`, o TMJLite pode parar
após *k* entradas do índice em vez de ordenar a tabela inteira (veja [Índices](#indices)).

---

## Atualizando dados

Use `UPDATE` para modificar valores em linhas existentes.

### Sintaxe

```sql
UPDATE table SET column1 = value1, column2 = value2 WHERE condition;
```

### Regras

- Sem `WHERE`, **todas as linhas** são atualizadas
- Colunas PK não podem ser atualizadas
- Valores são verificados quanto ao tipo da coluna
- Restrições NOT NULL são aplicadas
- Colunas HASH têm seus novos valores hasheados automaticamente
- Várias colunas podem ser atualizadas em uma única instrução

### Exemplos

```sql
-- Atualizar uma única linha
UPDATE users SET email = 'new@email.com' WHERE name = 'Thiago';

-- Atualizar várias colunas
UPDATE users SET city = 'SP', active = FALSE WHERE name = 'Maria';

-- Atualizar todas as linhas
UPDATE products SET in_stock = TRUE;

-- Atualizar com condição numérica
UPDATE products SET price = 199.90 WHERE price > 500.0;
```

### Saída

```
tmjlite> UPDATE users SET active = FALSE WHERE name = 'Joao';
Updated 1 row(s) in 'users'.

tmjlite> UPDATE products SET in_stock = TRUE;
Updated 5 row(s) in 'products'.
```

### Erros

```
Execution error: cannot update PK column 'id'
Execution error: column 'nope' not found in table 'users'
Type error: column 'age' expects INT, got Text("abc")
Execution error: column 'name' does not accept NULL (NOT NULL)
```

---

## Excluindo dados

Use `DELETE` para remover linhas de uma tabela.

### Sintaxe

```sql
DELETE FROM table WHERE condition;
```

### Regras

- Sem `WHERE`, **todas as linhas** são excluídas
- A estrutura da tabela é preservada — apenas os dados são removidos
- Linhas excluídas não podem ser recuperadas (a menos que o arquivo de banco de dados tenha sido copiado)

### Exemplos

```sql
-- Excluir linhas específicas
DELETE FROM users WHERE active = FALSE;

-- Excluir com condição complexa
DELETE FROM logs WHERE timestamp < '2026-01-01' AND level = 'DEBUG';

-- Excluir todas as linhas de uma tabela
DELETE FROM temp_data;
```

### Saída

```
tmjlite> DELETE FROM users WHERE name = 'Joao';
Deleted 1 row(s) from 'users'. (3 remaining)

tmjlite> DELETE FROM temp_data;
Deleted 100 row(s) from 'temp_data'. (0 remaining)
```

> Para zerar todas as linhas e manter schema/índices, prefira [`TRUNCATE TABLE`](#truncando-tabelas-truncate).

---

## Truncando tabelas (TRUNCATE)

Remove **todas** as linhas de uma tabela de uma vez, mantendo o schema e os índices
(incluindo `UNIQUE`). O contador interno de `rowid` é reiniciado.

### Sintaxe

```sql
TRUNCATE TABLE table_name;
```

### Regras

- Equivalente em efeito a `DELETE FROM table;` (sem `WHERE`), mas como operação dedicada
- A tabela continua existindo; índices são esvaziados e permanecem definidos
- Valores UNIQUE liberados — o mesmo valor pode ser inserido de novo após o truncate
- Pode ser desfeito com `ROLLBACK` dentro de uma transação

### Exemplos

```sql
TRUNCATE TABLE sessions;

BEGIN;
TRUNCATE TABLE audit_log;
ROLLBACK;  -- linhas de audit_log voltam
```

### Saída

```
tmjlite> TRUNCATE TABLE sessions;
Table 'sessions' truncated. (1520 row(s) removed)
```

### DELETE vs TRUNCATE vs DROP

| Comando | Linhas | Schema / índices | Tabela some? |
|---------|--------|------------------|--------------|
| `DELETE FROM t [WHERE …]` | Selecionadas ou todas | Mantidos | Não |
| `TRUNCATE TABLE t` | Todas | Mantidos (índices vazios) | Não |
| `DROP TABLE t` | Todas | Removidos | Sim |

---

## JOINs

Use JOINs para combinar linhas de duas ou mais tabelas com base em uma coluna relacionada.

### Sintaxe

```sql
SELECT columns
FROM table1 [alias]
[INNER] JOIN table2 [alias] ON condition
[LEFT JOIN table3 [alias] ON condition]
[RIGHT JOIN table4 [alias] ON condition]
[WHERE condition]
[ORDER BY column [ASC|DESC]]
[LIMIT n];
```

### Tipos de join

| Tipo          | Descrição                                                                          |
|---------------|------------------------------------------------------------------------------------|
| `INNER JOIN`  | Retorna apenas linhas que têm correspondência em ambas as tabelas                  |
| `JOIN`        | Equivalente a `INNER JOIN`                                                         |
| `LEFT JOIN`   | Retorna todas as linhas da tabela à esquerda; colunas da direita sem match são NULL |
| `RIGHT JOIN`  | Retorna todas as linhas da tabela à direita; colunas da esquerda sem match são NULL |

### INNER JOIN

Retorna apenas linhas em que a condição ON corresponde em ambas as tabelas.

```sql
SELECT users.name, orders.product
FROM users
INNER JOIN orders ON users.id = orders.user_id;
```

```
+--------+----------+
| name   | product  |
+--------+----------+
| Thiago | Notebook |
| Thiago | Mouse    |
| Maria  | Teclado  |
+--------+----------+
3 row(s)
```

`JOIN` sem `INNER` é equivalente:

```sql
SELECT users.name, orders.product
FROM users
JOIN orders ON users.id = orders.user_id;
```

### LEFT JOIN

Retorna todas as linhas da tabela à esquerda. Se não houver correspondência na tabela à direita, as colunas da direita são preenchidas com NULL.

```sql
SELECT u.name, a.city
FROM users u
LEFT JOIN addresses a ON u.id = a.user_id;
```

```
+--------+----------+
| name   | city     |
+--------+----------+
| Thiago | Curitiba |
| Maria  | NULL     |
| Joao   | SP       |
+--------+----------+
3 row(s)
```

### RIGHT JOIN

Retorna todas as linhas da tabela à direita. Se não houver correspondência na tabela à esquerda, as colunas da esquerda são preenchidas com NULL.

```sql
SELECT u.name, a.city
FROM users u
RIGHT JOIN addresses a ON u.id = a.user_id;
```

### Vários JOINs

Você pode encadear vários JOINs em uma única consulta:

```sql
SELECT u.name, o.product, a.city
FROM users u
JOIN orders o ON u.id = o.user_id
JOIN addresses a ON u.id = a.user_id;
```

### JOINs com WHERE, ORDER BY e LIMIT

Todas as cláusulas funcionam juntas:

```sql
SELECT u.name, o.product, o.total
FROM users u
JOIN orders o ON u.id = o.user_id
WHERE o.total > 100
ORDER BY o.total DESC
LIMIT 5;
```

### SELECT * com JOINs

`SELECT *` retorna todas as colunas de todas as tabelas unidas:

```sql
SELECT * FROM users u JOIN orders o ON u.id = o.user_id;
```

### Regras

- A cláusula ON deve comparar colunas (não literais)
- Para **equi-joins** (`table1.col = table2.col`), o TMJLite usa **hash join**
  automaticamente — muito mais rápido que nested-loop em tabelas grandes
- Se um nome de coluna existir em várias tabelas, você deve qualificá-lo com o nome da tabela ou apelido
- Nomes de coluna não qualificados que existem em apenas uma tabela são resolvidos automaticamente

Veja [Opções avançadas](#opcoes-avancadas) para forçar joins nested-loop em testes.

---

## Apelidos de tabela

Atribua um apelido curto ao nome de uma tabela por conveniência.

### Sintaxe

```sql
-- Usando a palavra-chave AS
SELECT u.name FROM users AS u;

-- Apelido implícito (sem AS)
SELECT u.name FROM users u;
```

### Uso

Apelidos funcionam em qualquer lugar: colunas SELECT, condições WHERE, ORDER BY e cláusulas ON de JOIN.

```sql
SELECT u.name, u.age
FROM users u
WHERE u.active = TRUE
ORDER BY u.name;
```

### Regras

- Apelidos diferenciam maiúsculas de minúsculas
- Uma vez definido um apelido, você pode usar o apelido ou o nome original da tabela para qualificar colunas
- Apelidos existem apenas durante a consulta

---

## Nomes qualificados de colunas

Use a sintaxe `table.column` ou `alias.column` para especificar a qual tabela uma coluna pertence.

### Sintaxe

```sql
-- Usando o nome da tabela
SELECT users.name FROM users;

-- Usando apelido
SELECT u.name FROM users u;
```

### Quando é obrigatório

- Quando um nome de coluna existe em várias tabelas unidas, você **deve** qualificá-lo
- Sem qualificação, o TMJLite retorna um erro para colunas ambíguas

```sql
-- Error: ambiguous column 'id' — exists in both users and orders
SELECT id FROM users JOIN orders ON users.id = orders.user_id;

-- Fix: qualify with table name or alias
SELECT users.id FROM users JOIN orders ON users.id = orders.user_id;
```

### Quando é opcional

Para consultas de uma única tabela ou quando um nome de coluna é único entre todas as tabelas unidas, a qualificação é opcional:

```sql
-- Ambos funcionam da mesma forma para consultas de uma tabela
SELECT name FROM users;
SELECT users.name FROM users;
SELECT u.name FROM users u;
```

---

## Agregações e GROUP BY

Funções de agregação resumem linhas: `COUNT(*)`, `COUNT(col)`, `SUM(col)`,
`MIN(col)`, `MAX(col)` e `AVG(col)`.

### Sintaxe

```sql
SELECT [colunas de agrupamento,] AGREGACAO(...), ...
FROM tabela
[WHERE ...]
GROUP BY col1 [, col2, ...]
[ORDER BY ...] [LIMIT n];
```

### Exemplos

```sql
-- Total de linhas (sem GROUP BY: só agregações na lista)
SELECT COUNT(*) FROM orders;

-- Por grupo
SELECT customer_id, COUNT(*), SUM(total), AVG(total)
FROM orders
GROUP BY customer_id
ORDER BY customer_id;

-- Vários níveis
SELECT country, city, MIN(price), MAX(price)
FROM listings
GROUP BY country, city;
```

### Regras

- Sem `GROUP BY`, a lista do `SELECT` só pode conter agregações
  (`SELECT COUNT(*) FROM t;`).
- Com `GROUP BY`, toda coluna não agregada precisa aparecer no `GROUP BY`
  (erro: `column 'x' must appear in GROUP BY or be used in an aggregate`).
- `SELECT *` não é permitido com `GROUP BY`.
- `NULL` forma um grupo próprio; `COUNT(col)` ignora `NULL`, `COUNT(*)` não.
- `HAVING` e `DISTINCT` ainda não são suportados — filtre com `WHERE` antes
  do agrupamento.
- Internamente é um *hash aggregate* (operador `HashAggregate` no `EXPLAIN`).

---

## Subconsultas

Um `SELECT` pode aparecer dentro de outro em três formas:

### IN / NOT IN

```sql
SELECT id FROM users WHERE id IN (SELECT user_id FROM orders);
SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM orders);
```

### EXISTS (correlacionada)

A subconsulta pode referenciar colunas da consulta externa pelo apelido:

```sql
SELECT id, name
FROM users u
WHERE EXISTS (SELECT id FROM orders o WHERE o.user_id = u.id)
ORDER BY id;
```

### Subconsulta escalar na lista do SELECT

```sql
SELECT name, (SELECT SUM(total) FROM orders o WHERE o.user_id = u.id)
FROM users u
ORDER BY name;
```

### Regras

- `IN`/`NOT IN` seguem a lógica de três valores do SQL: se a subconsulta
  devolve `NULL`, `NOT IN` não casa nenhuma linha.
- A subconsulta de `IN`/`EXISTS` deve devolver **uma** coluna.
- Subconsulta escalar combinada com `GROUP BY` na mesma consulta ainda não é
  suportada.

---

## Funções de janela

Calculam um valor por linha olhando um conjunto de linhas vizinhas, sem
agrupar o resultado. Suportadas: `ROW_NUMBER()`, `RANK()` e `SUM(col)`.

### Sintaxe

```sql
FUNCAO(...) OVER (
    [PARTITION BY col, ...]
    [ORDER BY col [ASC|DESC], ...]
    [ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW]
)
```

### Exemplos

```sql
-- Numera as vendas dentro de cada departamento, da maior para a menor
SELECT dept, rep, amt,
       ROW_NUMBER() OVER (PARTITION BY dept ORDER BY amt DESC)
FROM sales
ORDER BY dept, amt DESC;

-- Ranking com empates (mesmo score = mesmo rank)
SELECT name, RANK() OVER (ORDER BY score DESC) FROM players ORDER BY name;

-- Soma acumulada
SELECT id, SUM(amt) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
FROM payments
ORDER BY id;
```

### Regras

- O `ORDER BY` de fora da janela (da consulta) continua valendo para a ordem
  final das linhas; o `ORDER BY` dentro do `OVER` só define a janela.
- O frame `ROWS BETWEEN` é opcional; sem ele, `SUM` considera a partição
  inteira.

---

## Índices

O TMJLite usa índices B-Tree para acelerar buscas em chaves primárias e em colunas
que você indexa explicitamente. Os índices são mantidos automaticamente em INSERT, UPDATE e
DELETE, e persistidos no arquivo de banco de dados.

### Índice de chave primária (automático)

Toda coluna `PK` recebe um índice B-Tree automaticamente. Nenhum DDL é necessário.

- Criado quando a tabela é criada
- Atualizado incrementalmente em INSERT (apenas novas linhas são indexadas)
- Reconstruído em DELETE (posições das linhas mudam)
- Carregado do disco quando a tabela é acessada pela primeira vez na sessão

**Acelera** consultas de uma tabela com igualdade simples na PK:

```sql
SELECT * FROM users WHERE id = 'some-uuid';
SELECT name FROM users WHERE id = 'some-uuid';
```

### Índices secundários (CREATE INDEX)

Crie um índice em qualquer coluna não-PK — ou em **várias colunas** (índice composto) —
para acelerar filtros e consultas top-k ordenadas.

#### Sintaxe

```sql
CREATE [UNIQUE] INDEX index_name ON table_name (column1[, column2, ...]);
DROP INDEX index_name;
```

#### Exemplos

```sql
CREATE TABLE orders (id INT, user_id INT, status TEXT, total INT);
CREATE TABLE customers (id INT, email STRING(255));

-- Índice de uma coluna
CREATE INDEX idx_user ON orders (user_id);
CREATE UNIQUE INDEX idx_email ON customers (email);

-- Índice composto (multi-coluna)
CREATE INDEX idx_user_status ON orders (user_id, status);
CREATE UNIQUE INDEX idx_unique_pair ON orders (user_id, total);

DROP INDEX idx_user;
```

#### Regras

- Nomes de índice devem ser únicos no banco de dados
- Índices **compostos** (multi-coluna) são suportados — liste as colunas separadas por vírgula
- Não é possível indexar uma coluna PK (ela já possui índice)
- Não é possível criar dois índices no mesmo **conjunto de colunas** da mesma tabela
- `CREATE UNIQUE INDEX` falha se a tabela já contiver valores duplicados nessa(s) coluna(s);
  INSERT/UPDATE que criariam duplicata também são rejeitados. Em índices únicos compostos,
  a unicidade vale para a **combinação** dos valores; chaves com `NULL` são ignoradas
- Índices sobrevivem a `COMMIT`, reabertura, e são armazenados no catálogo do engine

#### Quando um índice secundário é usado

O engine de consultas usa um índice (PK ou secundário) quando **todas** estas condições se aplicam:

| Padrão                          | Exemplo                                                              |
|---------------------------------|----------------------------------------------------------------------|
| Igualdade                       | `WHERE indexed_col = literal`                                        |
| Igualdade composta (todas as colunas) | `WHERE col1 = a AND col2 = b` no índice `(col1, col2)`         |
| Prefixo de índice composto      | `WHERE col1 = a` usa o índice `(col1, col2)`                         |
| Intervalo (coluna única)        | `WHERE col > 5`, `WHERE col >= 5 AND col <= 10`                      |
| Top-k por coluna indexada       | `ORDER BY indexed_col ASC LIMIT k` (`WHERE` opcional na **mesma** coluna) |

```sql
-- Busca pontual via índice secundário
SELECT * FROM orders WHERE user_id = 42;

-- Igualdade composta: usa idx_user_status com a chave completa
SELECT * FROM orders WHERE user_id = 42 AND status = 'open';

-- Prefixo: usa a primeira coluna de idx_user_status
SELECT * FROM orders WHERE user_id = 42;

-- Varredura por intervalo
SELECT id FROM orders WHERE total >= 100 AND total <= 500;

-- Top 10 mais baratos (usa ordem do índice, sem ordenação completa)
SELECT id, total FROM orders ORDER BY total ASC LIMIT 10;
```

Use `EXPLAIN SELECT ...` para confirmar o plano — um seek composto aparece como
`IndexSeek(table=orders, index=(user_id,status), key=[42,open])`.

#### Quando um índice NÃO é usado

Estes ainda funcionam corretamente via varredura completa da tabela (ou join nested-loop):

- `WHERE` com `OR`, `NOT` ou colunas não indexadas
- `ORDER BY` em coluna não indexada, ou `DESC` em coluna indexada
- Consultas JOIN (chaves de join ainda não são aceleradas por índice no próprio join)
- Filtros `!=` / `<>` (sem intervalo de índice para desigualdade total)

### Inspecionando índices

O comando REPL `.schema` exibe apenas colunas da tabela. Metadados de índice ficam no
catálogo do engine; após `CREATE INDEX`, buscas pontuais nessa coluna usam o índice
imediatamente — nenhum passo extra é necessário.

### Correção importante (0.2.4): corrupção de índices em UPDATE/DELETE

Em versões **≤ 0.2.3**, executar `UPDATE` ou `DELETE` em uma tabela com índice
secundário corrompia silenciosamente o índice **em disco**: as buscas via índice
passavam a não encontrar linhas existentes (sem mensagem de erro) depois que o
banco era reaberto — tipicamente notado como consultas `WHERE a = ... AND b = ...`
retornando vazio para dados que existem, ou upserts criando duplicatas. Em casos
prolongados a corrupção podia se espalhar e impedir a abertura do arquivo
(`Storage error: trailing bytes after key`).

**Se o seu banco rodou UPDATE/DELETE em tabelas indexadas numa versão ≤ 0.2.3:**

1. Atualize para **0.2.4 ou superior** (obrigatório antes de qualquer escrita —
   a versão antiga re-corrompe o índice no próximo UPDATE)
2. Recrie os índices secundários para reconstruí-los sadios:

```sql
DROP INDEX idx_meu_indice;
CREATE INDEX idx_meu_indice ON minha_tabela (col1, col2);
```

Os dados das tabelas não são afetados — apenas as estruturas de índice.

---

## EXPLAIN

`EXPLAIN SELECT …` mostra o plano de execução (pipeline de operadores) sem
executar a consulta. É a forma de confirmar se um índice está sendo usado.

```
tmjlite> EXPLAIN SELECT id FROM t WHERE a = 1 ORDER BY a LIMIT 3;
+-----------------------------------------------------------------+
| plan                                                            |
+-----------------------------------------------------------------+
| IndexSeek(table=t, col=a, lower=Included(1), upper=Included(1)) |
| Project                                                         |
+-----------------------------------------------------------------+

tmjlite> EXPLAIN SELECT a, COUNT(*) FROM t GROUP BY a;
+---------------+
| plan          |
+---------------+
| TableScan(t)  |
| HashAggregate |
| Project       |
+---------------+
```

Operadores que você verá: `TableScan` (varredura completa), `IndexSeek`
(busca por índice, com os limites do intervalo), `Filter`, `Sort`, `Limit`,
`HashJoin` / `MergeJoin` / `IndexNestedLoopJoin` / `NestedLoopJoin`,
`HashAggregate`, `Project`. `TableScan` numa tabela grande com `WHERE` em
coluna indexável é o sinal para criar um índice.

---

## Transações

O TMJLite suporta transações explícitas com `BEGIN`, `COMMIT` e `ROLLBACK`.

### BEGIN

Inicia uma nova transação. Todas as alterações subsequentes ficam em memória até serem confirmadas ou revertidas:

```sql
BEGIN;
```

### COMMIT

Aplica todas as alterações feitas desde o `BEGIN` e as persiste em disco:

```sql
COMMIT;
```

### ROLLBACK

Descarta todas as alterações feitas desde o `BEGIN`, restaurando o banco de dados ao estado anterior ao início da transação:

```sql
ROLLBACK;
```

### Exemplo

```sql
-- Inserir alguns dados iniciais
INSERT INTO accounts VALUES ('Alice', 1000);
INSERT INTO accounts VALUES ('Bob', 500);

-- Iniciar uma transação
BEGIN;
UPDATE accounts SET balance = 800 WHERE name = 'Alice';
UPDATE accounts SET balance = 700 WHERE name = 'Bob';

-- Mudamos de ideia — desfazer tudo
ROLLBACK;
-- Alice ainda tem 1000, Bob ainda tem 500
```

### Regras

- Apenas uma transação por vez. `BEGIN` aninhado é um erro.
- `COMMIT` e `ROLLBACK` sem um `BEGIN` anterior é um erro.
- Auto-save é suprimido durante uma transação. Alterações são salvas em disco apenas no `COMMIT`.
- `ROLLBACK` desfaz todas as alterações: `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE TABLE`, `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `CREATE INDEX`, `DROP INDEX`.
- Tabelas são copiadas sob demanda na primeira mutação dentro de uma transação (copy-on-write) — `BEGIN` não clona mais o banco inteiro.
- Índices são atualizados incrementalmente em `UPDATE`; reconstruídos em `DELETE` quando índices de linha mudam.

---

## Log de antemão (WAL)

O TMJLite usa um Write-Ahead Log em nível de página no engine de armazenamento (formato `TMJP`) para
proteger contra gravações incompletas e falhas.

### Como funciona

1. Mutações anexam registros de redo a um arquivo sidecar `.pwal` antes que páginas sujas sejam gravadas
2. No checkpoint / `COMMIT`, páginas sujas e o catálogo são gravados no arquivo principal
3. Um checkpoint bem-sucedido trunca ou rotaciona o WAL

Arquivos `.tmjdb` legados (flat `TMJD` ou JSON) usam um WAL de arquivo inteiro mais simples; são
migrados para o formato do engine na abertura.

### Recuperação

Na inicialização, se existir um arquivo `.pwal` junto ao banco de dados:

- Registros WAL válidos são reaplicados para trazer o banco a um estado consistente
- Caudas WAL corrompidas ou incompletas são descartadas com segurança

Nenhuma ação do usuário é necessária — a recuperação é automática e transparente.

### Modos de durabilidade (`.sync`)

Controla o quão fortemente cada commit é gravado em disco:

| Modo               | Comando         | Comportamento                                                              |
|--------------------|-----------------|----------------------------------------------------------------------------|
| **full** (padrão)  | `.sync full`    | Durabilidade física por commit (`F_FULLFSYNC` no macOS)                    |
| **barrier**        | `.sync barrier` | Barreira de gravação — comparável ao SQLite da Apple com `fullfsync=ON`    |
| **normal**         | `.sync normal`  | Apenas `fsync` do SO — mais rápido, pequeno risco de perda em queda de energia |

```sql
.sync normal
BEGIN;
INSERT INTO t VALUES (1, 'bulk');
COMMIT;
```

---

## Trabalhando com arquivos de banco de dados

### Formato de arquivo

O TMJLite armazena dados em um único arquivo usando um **engine binário paginado** (magic `TMJP`,
páginas de 4096 bytes). Arquivos sidecar podem aparecer ao lado do banco de dados:

| Arquivo                  | Finalidade                                              |
|--------------------------|---------------------------------------------------------|
| `database.tmjp`          | Banco principal (tabelas, índices, catálogo)            |
| `database.tmjp.pwal`     | WAL em nível de página (transiente)                     |
| `database.tmjp.lock`     | Lock exclusivo enquanto uma sessão tem o arquivo aberto |
| `database.tmjp.shadows/` | Sessões shadow (`.tmjv`), branches (`.tmjb`) e quarentenas de merge (`.tmjc`) — ver [Branches de dados](#branches-de-dados-git-native) |

**Formatos legados** (migrados automaticamente na abertura, original mantido como `.bak` quando aplicável):

- **v2 flat** — magic `TMJD`, snapshot binário compactado
- **JSON** — `.tmjdb` legível por humanos de versões antigas do TMJLite

O arquivo é portátil: copie-o para qualquer máquina com TMJLite e abra-o.

### Acesso concorrente (0.2.5+)

O TMJLite é **um processo dono do arquivo por vez**: todo open (CLI, drivers,
TMJStudio) adquire um lock exclusivo no sidecar `.lock` e o segura enquanto o
banco estiver aberto. Um segundo processo tentando abrir recebe:

```
Storage error: database 'app.tmjp' is locked by another process
```

Isso é intencional — escritores de processos diferentes no mesmo arquivo
corrompem o pager/WAL (versões ≤ 0.2.4 permitiam e corrompiam silenciosamente).

**Concorrência de verdade acontece DENTRO do processo**, via `SharedConnection`
(driver Rust) / `SharedDb` (crate): SELECTs rodam em snapshot MVCC em paralelo
entre si e com o escritor; escritas serializam e são duráveis ao retornar.
Para N workers, use threads com um handle clonado — não N subprocessos:

```rust
let db = SharedConnection::open("app.tmjp")?;
let workers: Vec<_> = (0..8).map(|_| {
    let db = db.clone();
    std::thread::spawn(move || { /* db.query(...) / db.execute(...) */ })
}).collect();
```

**Vários processos escrevendo no mesmo arquivo** é o caso das **sessões
shadow** (`ShadowConnection` nos drivers Rust e C#, `tmjlite_shadow_*` no
FFI): cada processo trabalha sobre um snapshot do banco + as próprias
escritas, gravadas num `.tmjv` ao lado do arquivo; o `commit()` faz o merge
por chave primária no banco principal segurando o lock por milissegundos.
Nenhum processo bloqueia o outro; o que os vizinhos gravaram aparece após o
merge deles (e um `refresh()`). Conflitos — a mesma linha alterada nos dois
lados — seguem a política da tabela (`ALTER TABLE … SET MERGE POLICY`). A
versão nomeada e persistente disso são as [branches de
dados](#branches-de-dados-git-native). Detalhes por linguagem em
`drivers/<linguagem>/HowToUse.md`.

### Abrindo um arquivo na inicialização

```bash
tmjlite mydb.tmjp
```

Se o arquivo existir, ele é carregado. Se não, um banco vazio novo é criado nesse caminho.

### Abrindo um arquivo pelo REPL

```
tmjlite> .open mydb.tmjp
Opened mydb.tmjp
```

Isso substitui o banco em memória atual pelo conteúdo do arquivo.

### Salvando

Quando um arquivo de banco de dados está definido (via argumento na inicialização ou `.open`), todo comando SQL é salvo automaticamente.

Para salvar manualmente ou em um novo caminho:

```
tmjlite> .save                     -- salvar no arquivo atual
tmjlite> .save backup.tmjp        -- salvar em um novo arquivo
```

### Iniciando em memória, salvando depois

```
tmjlite> CREATE TABLE t (id PK, name STRING);
tmjlite> INSERT INTO t VALUES ('Thiago');
tmjlite> .save mydata.tmjp
Saved to mydata.tmjp
```

A partir desse ponto, todas as alterações são salvas automaticamente em `mydata.tmjp`.

---

## Compatibilidade e migração

O TMJLite abre bancos de versões anteriores e converte o que precisa na hora.
Nada exige ferramenta externa.

| De | Para | Quando | Backup |
|---|---|---|---|
| `.tmjdb` legado (JSON ou binário `TMJD`) | `.tmjp` (engine paginado) | Na **primeira abertura** (CLI, drivers ou Studio) | `<arquivo>.bak` ao lado |
| `.tmjp` pager v1 (sem checksum) | pager v2 (CRC32 por página) | Após qualquer escrita + checkpoint (fechar o REPL basta) | regrava in-place |
| Coluna `HASH` com SHA-256 antigo | Argon2id | No `UPDATE` da linha (migração preguiçosa) | a linha antiga continua verificando |
| Oplog de shadow/branch v1/v2 | v3 (base da linha + hash de schema) | Novos arquivos já nascem v3; v1/v2 são lidos normalmente | — |

**`.tmjdb` → `.tmjp`.** Ao abrir um arquivo legado, o TMJLite carrega os
dados, grava um `.tmjp` novo, renomeia o original para `<nome>.bak` e passa a
usar o engine paginado — a mensagem `Migrated legacy database to engine format
(backup: meu-banco.tmjdb.bak)` aparece no REPL. Para voltar ao legado *antes*
de continuar no `.tmjp`: `mv meu-banco.tmjdb.bak meu-banco.tmjdb`. Não há
downgrade automático; alterações feitas depois da migração existem só no
`.tmjp`. Abrir pelo driver dispara a mesma migração — garanta permissão de
escrita na pasta.

**Colunas HASH.** Bancos novos gravam Argon2id (`$argon2id$…`). Linhas antigas
com 64 caracteres hex (SHA-256) continuam funcionando na verificação; cada
linha migra quando for atualizada (`UPDATE users SET password = '…'`).

**Índices em bancos ≤ 0.2.3.** Qualquer banco que rodou `UPDATE`/`DELETE`
numa tabela indexada com versão ≤ 0.2.3 tem índices secundários corrompidos
no disco — ver [Correção importante (0.2.4)](#correcao-importante-024-corrupcao-de-indices-em-updatedelete).
Cura: abrir com 0.2.4+ e recriar os índices (`DROP INDEX` + `CREATE INDEX`).

**Checklist depois de atualizar a versão**

- [ ] Guardar o `.bak` até validar as consultas críticas.
- [ ] Reabrir o banco e rodar `EXPLAIN` nas consultas que dependem de índice.
- [ ] Se usa colunas `HASH`, testar login em linhas antigas e novas.
- [ ] Se usa branches/shadows, fazer merge dos pendentes (`tmjlite status`)
      antes de mudar o schema das tabelas envolvidas.

---

## Comandos do REPL e linha de comando

Comandos começam com `.` e não precisam de `;`.

| Comando           | Descrição                                                          |
|-------------------|--------------------------------------------------------------------|
| `.help`           | Exibir comandos disponíveis                                        |
| `.quit`           | Sair do TMJLite                                                    |
| `.exit`           | Sair do TMJLite (alias)                                           |
| `.tables`         | Listar todos os nomes de tabela                                    |
| `.schema`         | Exibir CREATE TABLE de todas as tabelas                            |
| `.schema users`   | Exibir CREATE TABLE de uma tabela específica                       |
| `.save`           | Salvar no arquivo de banco de dados atual                          |
| `.save path.tmjp` | Salvar em um arquivo específico                                    |
| `.open path.tmjp` | Abrir um arquivo de banco de dados                                 |
| `.sync full`      | Durabilidade: flush físico por commit (padrão)                     |
| `.sync barrier`   | Durabilidade: barreira de gravação (classe SQLite da Apple)        |
| `.sync normal`    | Durabilidade: apenas fsync do SO (mais rápido)                     |
| `.prepare INSERT INTO t VALUES (?, ?);` | Prepara um INSERT com placeholders `?` para repetir com `.exec` |
| `.exec v1,v2`     | Executa o INSERT preparado com os valores (strings com vírgula entre aspas simples) |
| `.status`         | Branches, sessões shadow pendentes e quarentenas do banco aberto   |
| `.log <branch>`   | Histórico de commits de uma branch                                 |
| `.merge <branch> [--policy p] [--keep]` | Aplica uma branch no banco aberto           |

### Prepared statements

Para inserir muitas linhas uma a uma sem pagar o parse a cada vez:

```
tmjlite> .prepare INSERT INTO users (name, age) VALUES (?, ?);
Prepared INSERT into 'users' (2 parameter(s)). Use .exec v1,v2,...
tmjlite> .exec 'Alice',30
tmjlite> .exec 'Bob, Jr.',41
```

Nos drivers o equivalente é `prepare()`/`execute_batch()` (Rust) — ou,
mais simples, o INSERT multi-linha (ver [Dica: grave em lote](#dica-grave-em-lote)).

### Subcomandos de linha de comando

Além de `tmjlite <arquivo>` (abre o REPL), o binário tem subcomandos para as
[branches de dados](#branches-de-dados-git-native):

```bash
tmjlite status   <db>                      # branches, shadows pendentes, quarentenas
tmjlite branch   <db> [<nome> | -d <nome>] # listar / criar / apagar
tmjlite checkout <db> <nome>               # REPL na branch
tmjlite commit   <db> <nome> -m "msg" [--author quem]
tmjlite log      <db> <nome>
tmjlite merge    <db> <nome> [--policy lww|error|field_merge|manual] [--keep]
tmjlite help
```

### Atalhos de teclado

| Tecla      | Ação                              |
|------------|-----------------------------------|
| Up/Down    | Navegar no histórico de comandos  |
| Left/Right | Mover o cursor na linha atual     |
| Ctrl+C     | Cancelar a entrada atual          |
| Ctrl+D     | Sair do TMJLite                   |

---

## Opções avançadas

Estas variáveis de ambiente afetam a execução de consultas. São destinadas a
benchmarks, depuração e testes de compatibilidade — o uso normal não exige
configurá-las.

| Variável                    | Valores   | Efeito                                                                                                                                 |
|-----------------------------|-----------|----------------------------------------------------------------------------------------------------------------------------------------|
| `TMJLITE_FORCE_NESTED_JOIN` | `1` ou `true` | Força joins nested-loop em vez de hash/merge/index join em equi-joins (`col = col`). Mais lento em tabelas grandes.              |
| `TMJLITE_AUTHOR`            | texto     | Autor padrão dos commits de branch (`tmjlite commit`, `.commit`). Sem ela, usa `$USER`.                                               |

Exemplo:

```bash
# Benchmark de algoritmos de join
TMJLITE_FORCE_NESTED_JOIN=1 tmjlite mydb.tmjp
```

> A variável `TMJLITE_READPATH=inline` de versões anteriores foi removida: o
> pipeline de operadores (Volcano) é o único caminho de leitura desde a 0.2.6.

Quando stdin é redirecionado (scripts, pipes), o TMJLite roda em **modo batch** — sem
overhead de edição de linha, igual a alimentar SQL a partir de um arquivo.

---

## Desempenho e benchmarks

O TMJLite é otimizado para cargas de trabalho **local-first, duráveis e versionáveis** — não para superar o
SQLite em todo micro-benchmark. As seções abaixo ajudam você a entender o que é rápido hoje e
onde procurar números.

### O que é rápido

| Recurso                          | Por quê                                                                 |
|----------------------------------|-------------------------------------------------------------------------|
| Busca PK / índice secundário     | Busca B-Tree — `WHERE indexed_col = value`                              |
| Intervalo em coluna indexada     | Varredura por intervalo no índice — `WHERE col >= a AND col <= b`     |
| Top-k por coluna indexada        | `ORDER BY indexed_col ASC LIMIT k` sem ordenação completa               |
| Equi-join (`col = col`)          | Hash join (build + probe)                                               |
| INSERT em lote em uma transação  | Um sync no `COMMIT`; índice PK atualizado incrementalmente              |
| Transações multi-tabela          | Copy-on-write por tabela no `BEGIN` (sem clone completo do banco)       |

### O que ainda é mais lento que o SQLite

- Gravações limitadas por fsync em autocommit (ambos os engines pagam sync em disco; SQLite é mais afinado)
- Varreduras completas de tabela em colunas não indexadas
- Join vs SQLite em equi-joins grandes (materializamos ambos os lados; o VDBE do SQLite é maduro)
- Overhead do parser em muitas instruções pequenas (ainda sem prepared statements)

### Novidades desde a 0.2.6 (próxima release)

- **Branches de dados e sessões shadow** — escrita multi-processo por merge,
  branches nomeadas com commits, políticas de conflito por tabela
  (`ALTER TABLE … SET MERGE POLICY`), CLI `tmjlite branch/checkout/commit/merge/log/status`.
  Ver [Branches de dados](#branches-de-dados-git-native).
- Literal inteiro aceito em colunas `FLOAT` no `INSERT`/`UPDATE`.
- Tabelas do REPL alinhadas corretamente.

### Melhorias recentes (0.2.6)

- **Bulk insert até 125× mais rápido**: o caminho de escrita reaproveitava a
  tabela inteira a cada INSERT (custo O(N²) em cargas grandes) — corrigido para
  enviar ao engine apenas as linhas novas; índices agora são alimentados em
  lote e em ordem de chave. Régua pública: 1 milhão de linhas com durabilidade
  total por statement foi de ~254 para ~31.700 linhas/s
  (`drivers/python/stress-test.py`).

### Dica: grave em lote

O TMJLite é **durável por statement** — cada comando só retorna depois do
fsync. Para cargas de escrita intensa, prefira INSERTs multi-linha:

```sql
-- 1 fsync para 500 linhas (rápido):
INSERT INTO listings (agency_id, external_id) VALUES
    ('ag1', 'e1'),
    ('ag1', 'e2'),
    -- ... até algumas milhares de linhas por statement ...
    ('ag1', 'e500');

-- 500 fsyncs (lento — use só quando cada linha precisa confirmar sozinha):
INSERT INTO listings (agency_id, external_id) VALUES ('ag1', 'e1');
```

Lotes de 500–5.000 linhas são o ponto ideal medido; acima disso o ganho satura.

### Executando benchmarks

Cenários de benchmark comparam durabilidade e caminhos de consulta do TMJLite no seu hardware.
Entre em contato com **TMJ Sistemas** para os relatórios e metodologia de benchmark mais recentes.

### Documentação de referência

| Tópico            | Observações                                      |
|-------------------|--------------------------------------------------|
| Metodologia       | Fornecida pela TMJ Sistemas mediante solicitação |
| Resultados recentes | Incluídos nas releases do produto               |
| Roadmap           | Disponível sob suporte comercial                 |

Razões aproximadas vs SQLite em Apple Silicon (mediana de 5 rodadas, 2026-06-24):

| Cenário                          | TMJ / SQLite        |
|----------------------------------|---------------------|
| Bulk INSERT (1 txn, 50k rows)    | ~1,4×               |
| Full scan (100× 50k rows)        | ~1,6×               |
| Equi-join (3k+3k, 30 joins)      | ~6× slower          |
| Hash vs nested (TMJ only)        | **~299×** faster with hash join |

Números absolutos variam com a carga da máquina; entre em contato com TMJ Sistemas para valores no seu hardware.

---

## Comentários

Comentários de linha começam com `--`. Tudo após `--` na linha é ignorado.

```sql
-- Criar a tabela users
CREATE TABLE users (
    id PK,              -- UUID gerado automaticamente
    name STRING(100),   -- máximo 100 caracteres
    created DATE DEFAULT(TODAY)
);
```

---

## Mensagens de erro

### Erros de parse

Problema na sintaxe SQL:

```
Parse error: expected identifier, got IntegerLiteral(42)
Parse error: unexpected character: '@'
Parse error: unterminated string
Parse error: STRING size must be 0-8000, got 9000
```

### Erros de execução

Problema com a operação:

```
Execution error: table 'users' already exists
Execution error: table 'xyz' not found
Execution error: expected 2 values (Pk columns are auto-generated), got 3
Execution error: column 'abc' not found in table 'users'
Execution error: only one Pk column allowed per table
Execution error: column 'x': Default(Today) is only valid for Date and DateTime
Execution error: column 'x': HASH is only valid for TEXT and STRING columns
Execution error: column 'x' does not accept NULL (NOT NULL)
Execution error: cannot add NOT NULL column 'x' without a default to a table with existing rows
Execution error: cannot add PK column with ALTER TABLE
Execution error: cannot drop PK column
Execution error: cannot drop the last column of a table
Execution error: cannot modify PK column
Execution error: cannot change column type from INT to TEXT
Execution error: column 'x': cannot remove HASH (irreversible)
Execution error: column 'x': existing data contains NULL values, cannot set NOT NULL
Execution error: column 'x': default value Int(0) does not match type TEXT
Execution error: column count (2) does not match value count (3)
Execution error: column 'id' is Pk and cannot be set manually
Execution error: column 'x' already exists in table 'users'
Execution error: cannot update PK column 'id'
Execution error: column 'x' not found in table 'users'
Execution error: index 'idx_x' already exists
Execution error: index 'idx_x' not found
Execution error: columns (email) are already indexed on 'users'
Execution error: primary key column already has an index
Execution error: unique index 'idx_email': duplicate value Text("a@b.com")
Execution error: table or alias 'x' not found
Execution error: ambiguous column 'id' — qualify with table name or alias
```

### Erros de tipo

Valor não corresponde ao tipo da coluna ou à validação:

```
Type error: column 'id' expects INT, got Text("hello")
Type error: column 'code': string length 4 exceeds STRING(3)
Type error: column 'd': invalid date 'abc', expected yyyy-MM-dd
Type error: column 'ts': invalid datetime 'abc', expected yyyy-MM-dd HH:mm:ss:ms
Type error: column 'x': default string length 10 exceeds STRING(5)
```

### Erros de armazenamento

Problema ao ler/gravar o arquivo de banco de dados:

```
Storage error: read failed: No such file or directory
Storage error: write failed: Permission denied
```

---

## Exemplos

### Sistema de cadastro de usuários

```sql
CREATE TABLE users (
    id PK,
    name STRING(100) NOT NULL,
    email STRING(255) NOT NULL,
    password STRING(255) NOT NULL HASH,
    city STRING(50) DEFAULT('Curitiba'),
    registered_at DATETIME DEFAULT(TODAY),
    active BOOL DEFAULT(TRUE)
);

-- Inserção posicional: todos os valores não-PK
INSERT INTO users VALUES ('Thiago', 'thiago@email.com', 'mypassword123', NULL, NULL, NULL);

-- Lista de colunas: apenas o que importa, o restante recebe padrões
INSERT INTO users (name, email, password) VALUES ('Maria', 'maria@email.com', 'senha_secreta');

-- Inserção em lote
INSERT INTO users (name, email, password, city) VALUES
    ('Joao', 'joao@email.com', 'j0a0_2026', 'SP'),
    ('Ana', 'ana@email.com', 'ana_pwd', 'RJ');

-- Consulta com WHERE
SELECT name, email, city FROM users WHERE active = TRUE ORDER BY name;

-- Desativar um usuário
UPDATE users SET active = FALSE WHERE name = 'Joao';

-- Encontrar usuários inativos
SELECT name, email FROM users WHERE active = FALSE;

-- Remover usuários inativos
DELETE FROM users WHERE active = FALSE;
```

### Catálogo de produtos

```sql
CREATE TABLE products (
    id PK,
    name STRING(200) NOT NULL,
    price FLOAT NOT NULL,
    category STRING(50) DEFAULT('Geral'),
    in_stock BOOL DEFAULT(TRUE),
    added DATE DEFAULT(TODAY)
);

INSERT INTO products (name, price) VALUES ('Keyboard', 249.90);
INSERT INTO products (name, price) VALUES ('Mouse', 89.90);
INSERT INTO products VALUES ('Monitor 4K', 2499.00, 'Electronics', FALSE, '2026-01-15');

-- Adicionar uma nova coluna depois
ALTER TABLE products ADD brand STRING(100) DEFAULT('Generic');

-- Consulta com filtro, ordenação e limite
SELECT name, price, category FROM products WHERE in_stock = TRUE ORDER BY price DESC;

-- Top 2 produtos mais caros
SELECT name, price FROM products ORDER BY price DESC LIMIT 2;

-- Atualização de preço
UPDATE products SET price = 229.90 WHERE name = 'Keyboard';

-- Marcar itens fora de estoque
UPDATE products SET in_stock = FALSE WHERE price > 2000.0;

-- Remover itens descontinuados
DELETE FROM products WHERE in_stock = FALSE AND category = 'Geral';
```

### Log de auditoria

```sql
CREATE TABLE audit (
    id PK,
    action STRING(50) NOT NULL,
    details TEXT,
    timestamp DATETIME DEFAULT(TODAY)
);

INSERT INTO audit (action, details) VALUES ('LOGIN', 'User thiago logged in');
INSERT INTO audit (action, details) VALUES ('UPDATE', 'Changed email for user 42');
INSERT INTO audit (action, details) VALUES ('DELETE', 'Removed inactive accounts');

-- Ver ações recentes
SELECT * FROM audit ORDER BY timestamp DESC LIMIT 10;

-- Encontrar ações específicas
SELECT action, details FROM audit WHERE action = 'LOGIN';

-- Limpar entradas antigas
DELETE FROM audit WHERE timestamp < '2026-01-01 00:00:00:000';
```

### Evolução de schema

```sql
-- Começar simples
CREATE TABLE contacts (id PK, name STRING(100) NOT NULL);

INSERT INTO contacts (name) VALUES ('Thiago'), ('Maria'), ('Joao');

-- Adicionar colunas conforme necessário
ALTER TABLE contacts ADD email STRING(255);
ALTER TABLE contacts ADD city STRING(50) NOT NULL DEFAULT('Curitiba');

-- Alterar tamanho da coluna
ALTER TABLE contacts MODIFY name STRING(255);

-- Atualizar dados em linhas existentes
UPDATE contacts SET email = 'thiago@email.com' WHERE name = 'Thiago';
UPDATE contacts SET city = 'SP' WHERE name = 'Maria';

-- Verificar o resultado
.schema contacts
SELECT * FROM contacts ORDER BY name;
```

### Pedidos com índices e joins

```sql
CREATE TABLE customers (id INT, name STRING(100));
CREATE TABLE orders (id INT, customer_id INT, product STRING(100), total INT);

INSERT INTO customers VALUES (1, 'Thiago'), (2, 'Maria');
INSERT INTO orders VALUES (10, 1, 'Notebook', 5000);
INSERT INTO orders VALUES (11, 1, 'Mouse', 100);
INSERT INTO orders VALUES (12, 2, 'Teclado', 300);

-- Acelerar buscas por cliente e top-k ordenado por total
CREATE INDEX idx_orders_customer ON orders (customer_id);
CREATE INDEX idx_orders_total ON orders (total);

-- Índice composto: filtros por cliente + produto na mesma consulta
CREATE INDEX idx_customer_product ON orders (customer_id, product);

-- Join usa hash join em equi-key; filtro usa índice em customer_id
SELECT c.name, o.product, o.total
FROM customers c
JOIN orders o ON c.id = o.customer_id
WHERE o.customer_id = 1;

-- Top 2 pedidos por valor (ORDER BY + LIMIT com suporte de índice)
SELECT id, total FROM orders ORDER BY total ASC LIMIT 2;

DROP INDEX idx_orders_customer;
```

---

## Branches de dados (git-native)

Um banco `.tmjp` pode ter **branches**: cópias lógicas onde você insere,
altera e apaga linhas sem tocar o arquivo principal, e depois faz **merge**.
É o mesmo mecanismo das sessões shadow dos drivers, com nome, persistência
e histórico de commits. Tudo fica em `<banco>.shadows/<nome>.tmjb`.

```bash
tmjlite branch   loja.tmjp importacao           # cria a branch
tmjlite checkout loja.tmjp importacao           # abre um REPL NA branch
```

Dentro do REPL da branch, o SQL normal (`INSERT`/`UPDATE`/`DELETE`/`SELECT`)
opera sobre a branch — o `loja.tmjp` continua intocado e outros processos
continuam usando ele:

```text
tmjlite(importacao)> INSERT INTO produtos (nome, preco) VALUES ('Caneca', 39.9);
tmjlite(importacao)> UPDATE produtos SET preco = 42 WHERE nome = 'Caneca';
tmjlite(importacao)> .commit -m "primeira leva de produtos"
tmjlite(importacao)> .quit
```

Pela linha de comando, sem entrar no REPL:

```bash
tmjlite commit loja.tmjp importacao -m "mensagem" [--author nome]   # sela as ops pendentes
tmjlite log    loja.tmjp importacao                                 # histórico de commits
tmjlite status loja.tmjp                                            # branches e pendências
tmjlite merge  loja.tmjp importacao                                 # aplica no banco principal
```

Regras:
- Só ops **commitadas** (`.commit` / `tmjlite commit`) entram no merge. Ops
  soltas depois do último commit fazem o merge falhar pedindo pra commitar.
- O merge consome a branch (o arquivo `.tmjb` some). `--keep` mantém a
  branch como estava (útil pra reaplicar em outro banco).
- Conflitos (a mesma linha alterada no banco principal desde que a branch
  nasceu) seguem a política da tabela — ver `ALTER TABLE … SET MERGE POLICY`
  — ou `--policy lww|error|field_merge|manual` no merge.
- Se o schema da tabela mudou no banco principal (colunas/tipos) depois que a
  branch foi criada, o merge é recusado com "schema divergence".
- Branches são **DML-only**: `CREATE`/`ALTER`/`DROP`/`BEGIN` não rodam na
  branch — rode no banco principal.
- `tmjlite branch loja.tmjp -d importacao` apaga a branch (as ops não
  mergeadas são perdidas).

### Guia completo e FAQ

O que a aplicação enxerga enquanto uma branch está aberta, convivência com
workers, lock, conflitos e receitas por cenário: [Branches de dados e
concorrência](branches.html) (no repositório, `docs/Branches.md`).

### Nos drivers

Os drivers estão nos registros oficiais (`pip install tmjlite`, `npm install
tmjlite`, `io.github.tmjacometti:tmjlite` no Maven Central, `dotnet add
package TMJLite`; o driver Rust é SDK sob licença), com o motor nativo dentro do pacote.
A mesma branch é acessível por código: `ShadowConnection::open_branch` /
`seal` / `commit` no driver Rust, `TMJLite.OpenBranch` / `Seal` / `Commit`
no C#, `tmjlite_shadow_open_branch` / `_seal` no FFI. Sessões **anônimas**
(`ShadowConnection::open`, `TMJLite.ConnectShadow`) são o mesmo mecanismo sem
nome nem commits: o `commit()` já faz o merge — é o modo para N workers de um
crawler ou ETL gravando em paralelo. Exemplos em `drivers/rust/HowToUse.md` e
`drivers/csharp/HowToUse.md`; desenho completo em `docs/engine/GIT_MERGE.md`.
