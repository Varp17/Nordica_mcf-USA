-- Create generate_invoice_number procedure
DROP PROCEDURE IF EXISTS generate_invoice_number;

DELIMITER $$

CREATE PROCEDURE generate_invoice_number(IN p_order_number VARCHAR(25), OUT new_invoice_number VARCHAR(30))
BEGIN
  DECLARE next_val INT;
  DECLARE v_prefix VARCHAR(10) DEFAULT 'INV-';
  
  -- Simple sequential invoice number
  INSERT INTO order_sequences (year, month, last_number, prefix)
    VALUES (99, 99, 10001, 'INV-')
  ON DUPLICATE KEY UPDATE last_number = last_number + 1;
  
  SELECT last_number INTO next_val FROM order_sequences WHERE year = 99 AND month = 99;
  
  SET new_invoice_number = CONCAT(v_prefix, next_val);
END$$

DELIMITER ;
